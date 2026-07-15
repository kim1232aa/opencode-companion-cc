// The `occ` launcher.
//
// The requirement that drives every test here: the launcher must NEVER pin a
// version. Claude Code installs each plugin release into its own versioned dir
// (…/opencode/2.2.0/, …/2.3.0/, …), so a launcher that baked "2.2.0" into itself
// would break on the very next upgrade — silently, and looking like the plugin
// was at fault. So the last test in "version resolution" installs a launcher,
// then *adds a newer version dir behind its back*, and re-runs the SAME launcher.
//
// Everything installs into a TEMP HOME. No test may touch the real ~/.local/bin.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  DEFAULT_CLI_NAME,
  LAUNCHER_MARKER,
  compareVersions,
  pickLatestVersion,
  resolveInstallSource,
  renderLauncher,
  findCommandConflict,
  isOurLauncher,
  installCli,
  uninstallCli,
  pathHint,
} from "../plugins/opencode/scripts/lib/cli-install.mjs";

let home;
let binDir;

beforeEach(() => {
  home = createTmpDir("occ-home");
  binDir = path.join(home, ".local", "bin");
});

afterEach(() => {
  cleanupTmpDir(home);
});

/**
 * Build a fake Claude Code plugin cache:
 *   <home>/.claude/plugins/cache/opencode-companion-cc/opencode/<version>/scripts/opencode-companion.mjs
 * Each version's script just prints its own version, so a launcher's choice is
 * directly observable by running it.
 */
function fakeCache(versions) {
  const pluginDir = path.join(
    home, ".claude", "plugins", "cache", "opencode-companion-cc", "opencode"
  );
  for (const v of versions) {
    const scripts = path.join(pluginDir, v, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(
      path.join(scripts, "opencode-companion.mjs"),
      `console.log("VERSION ${v} ARGS " + process.argv.slice(2).join(","));\n`
    );
  }
  return pluginDir;
}

const scriptIn = (pluginDir, v) =>
  path.join(pluginDir, v, "scripts", "opencode-companion.mjs");

describe("version ordering", () => {
  it("orders numerically, not as strings (2.10.0 > 2.9.0)", () => {
    assert.equal(pickLatestVersion(["2.9.0", "2.10.0", "2.2.0"]), "2.10.0");
    assert.ok(compareVersions("2.10.0", "2.9.0") > 0);
  });

  it("picks the newest out of a realistic install set", () => {
    assert.equal(
      pickLatestVersion(["2.0.1", "2.0.3", "2.0.5", "2.1.0", "2.1.1", "2.2.0"]),
      "2.2.0"
    );
  });

  it("ranks a prerelease below its own release", () => {
    assert.equal(pickLatestVersion(["2.3.0-rc.1", "2.3.0"]), "2.3.0");
    assert.equal(pickLatestVersion(["2.3.0-rc.1", "2.2.0"]), "2.3.0-rc.1");
  });

  it("ignores junk directory names outright", () => {
    assert.equal(pickLatestVersion(["1.0.0", "tmp", ".DS_Store", "backup"]), "1.0.0");
    assert.equal(pickLatestVersion(["tmp", "junk"]), null);
    assert.equal(pickLatestVersion([]), null);
  });
});

describe("resolveInstallSource", () => {
  it("recognizes a real plugin install and derives the version-agnostic plugin dir", () => {
    const p = "/h/.claude/plugins/cache/opencode-companion-cc/opencode/2.2.0/scripts/opencode-companion.mjs";
    const src = resolveInstallSource(p);
    assert.equal(src.kind, "plugin");
    assert.equal(src.pluginDir, "/h/.claude/plugins/cache/opencode-companion-cc/opencode");
    assert.doesNotMatch(src.pluginDir, /2\.2\.0/, "the version must NOT be part of the dir");
  });

  it("derives owner/repo/plugin instead of hardcoding them (a fork installs too)", () => {
    const p = "/h/.claude/plugins/cache/someone-else-fork/oc/9.9.9/scripts/opencode-companion.mjs";
    assert.equal(resolveInstallSource(p).pluginDir, "/h/.claude/plugins/cache/someone-else-fork/oc");
  });

  it("treats a source checkout as a checkout (no sibling versions to choose from)", () => {
    const src = resolveInstallSource("/home/me/gitprojects/opencode-companion-cc/plugins/opencode/scripts/opencode-companion.mjs");
    assert.equal(src.kind, "checkout");
    assert.equal(src.pluginDir, null);
  });
});

describe("the generated launcher", () => {
  it("carries the marker and hardcodes NO version", () => {
    const src = resolveInstallSource("/h/.claude/plugins/cache/o-c/opencode/2.2.0/scripts/opencode-companion.mjs");
    const text = renderLauncher(src);
    assert.match(text, new RegExp(LAUNCHER_MARKER));
    assert.match(text, /^#!\/usr\/bin\/env node/);
    assert.doesNotMatch(text, /2\.2\.0/, "a baked-in version is the whole bug we are avoiding");
  });

  it("a checkout launcher points straight at the checked-out script", () => {
    const src = resolveInstallSource("/repo/plugins/opencode/scripts/opencode-companion.mjs");
    const text = renderLauncher(src);
    assert.match(text, /PLUGIN_DIR = null/);
    assert.match(text, /\/repo\/plugins\/opencode\/scripts\/opencode-companion\.mjs/);
  });

  it("surfaces a signal-kill of the target as 128+signum, never a false exit 0", () => {
    const pluginDir = fakeCache(["1.0.0"]);
    // Make the target script kill ITSELF with SIGTERM. spawnSync then returns
    // { status: null, signal: "SIGTERM" } — the case the launcher used to report
    // as a clean exit 0, masking a killed run as success.
    fs.writeFileSync(scriptIn(pluginDir, "1.0.0"), `process.kill(process.pid, "SIGTERM");\n`);
    const launcher = path.join(home, "occ-signal.cjs");
    fs.writeFileSync(launcher, renderLauncher(resolveInstallSource(scriptIn(pluginDir, "1.0.0"))));
    const res = spawnSync(process.execPath, [launcher], { encoding: "utf8" });
    assert.equal(res.status, 143, `a SIGTERM-killed target must surface as 143 (128+15), got status=${res.status} signal=${res.signal}`);
  });
});

describe("install / uninstall", () => {
  it("installs an executable launcher into <home>/.local/bin and NOT the real HOME", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home,
      env: { PATH: "/usr/bin" },
    });

    assert.equal(res.path, path.join(binDir, "occ"));
    assert.equal(res.name, DEFAULT_CLI_NAME);
    assert.equal(res.action, "installed");
    assert.ok(fs.existsSync(res.path));

    const mode = fs.statSync(res.path).mode & 0o777;
    assert.equal(mode, 0o755, "must be executable");
    assert.ok(isOurLauncher(res.path));
  });

  it("is idempotent: reinstalling overwrites our own launcher without complaint", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const opts = { scriptPath: scriptIn(pluginDir, "2.2.0"), home, env: { PATH: "/usr/bin" } };

    assert.equal(installCli(opts).action, "installed");
    assert.equal(installCli(opts).action, "updated");
    assert.equal(installCli(opts).action, "updated");
    assert.equal(fs.statSync(path.join(binDir, "occ")).mode & 0o777, 0o755);
  });

  it("honors --cli-name", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: "/usr/bin" }, name: "ocx",
    });
    assert.equal(res.path, path.join(binDir, "ocx"));
    assert.ok(fs.existsSync(path.join(binDir, "ocx")));
  });

  it("rejects a garbage command name", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    assert.throws(
      () => installCli({ scriptPath: scriptIn(pluginDir, "2.2.0"), home, name: "../../evil" }),
      /Invalid CLI name/
    );
  });

  it("uninstall removes it", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    installCli({ scriptPath: scriptIn(pluginDir, "2.2.0"), home, env: { PATH: "/usr/bin" } });

    assert.equal(uninstallCli({ home }).action, "removed");
    assert.equal(fs.existsSync(path.join(binDir, "occ")), false);
  });

  it("uninstall on a clean machine is a no-op, not an error", () => {
    assert.equal(uninstallCli({ home }).action, "absent");
  });
});

describe("name collisions — never shadow, never eat, someone else's command", () => {
  /** Put a foreign executable named `name` in a dir, and return that dir. */
  function foreignCommand(name) {
    const dir = path.join(home, "usr-bin");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, "#!/bin/sh\necho I am someone else\n", { mode: 0o755 });
    return dir;
  }

  it("refuses to install over a DIFFERENT command already on PATH (e.g. `oc`)", () => {
    const otherDir = foreignCommand("occ");
    const pluginDir = fakeCache(["2.2.0"]);

    assert.throws(
      () => installCli({
        scriptPath: scriptIn(pluginDir, "2.2.0"),
        home, env: { PATH: otherDir },
      }),
      /already on your PATH[\s\S]*--cli-name/
    );
    assert.equal(fs.existsSync(path.join(binDir, "occ")), false, "nothing was written");
  });

  it("findCommandConflict points at the offending path", () => {
    const otherDir = foreignCommand("occ");
    assert.equal(findCommandConflict("occ", { env: { PATH: otherDir } }), path.join(otherDir, "occ"));
    assert.equal(findCommandConflict("occ", { env: { PATH: "/nonexistent" } }), null);
  });

  it("does NOT count our OWN previous launcher as a conflict (that's an upgrade)", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const env = { PATH: binDir };
    installCli({ scriptPath: scriptIn(pluginDir, "2.2.0"), home, env });

    assert.equal(findCommandConflict("occ", { env }), null);
    assert.equal(installCli({ scriptPath: scriptIn(pluginDir, "2.2.0"), home, env }).action, "updated");
  });

  it("refuses to install over a foreign file sitting at the exact target path", () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "occ"), "#!/bin/sh\necho not ours\n", { mode: 0o644 });
    const pluginDir = fakeCache(["2.2.0"]);

    assert.throws(
      () => installCli({ scriptPath: scriptIn(pluginDir, "2.2.0"), home, env: { PATH: "/usr/bin" } }),
      /was not created by this plugin/
    );
    assert.match(fs.readFileSync(path.join(binDir, "occ"), "utf8"), /not ours/);
  });

  it("refuses to UNINSTALL a file it did not write", () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "occ"), "#!/bin/sh\necho precious\n", { mode: 0o755 });

    assert.throws(() => uninstallCli({ home }), /not created by this plugin/);
    assert.ok(fs.existsSync(path.join(binDir, "occ")), "an uninstall must never eat a stranger's binary");
  });
});

describe("PATH guidance", () => {
  it("reports onPath and offers no hint when ~/.local/bin is already there", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: `/usr/bin:${binDir}` },
    });
    assert.equal(res.onPath, true);
    assert.equal(res.hint, null);
  });

  it("offers a paste-able one-liner when it is NOT on PATH", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: "/usr/bin", SHELL: "/bin/bash" },
    });
    assert.equal(res.onPath, false);
    assert.match(res.hint, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    assert.match(res.hint, /\.bashrc/);
  });

  it("adapts the rc file to the user's shell", () => {
    assert.match(pathHint("/h/.local/bin", { SHELL: "/bin/zsh" }, "/h"), /\.zshrc/);
    assert.match(pathHint("/h/.local/bin", { SHELL: "/usr/bin/fish" }, "/h"), /fish_add_path/);
  });
});

describe("version resolution AT RUN TIME (the upgrade-survival contract)", () => {
  it("execs the NEWEST installed version, forwarding its arguments", () => {
    const pluginDir = fakeCache(["2.0.5", "2.1.0", "2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.0.5"), // installed FROM an old version…
      home, env: { PATH: "/usr/bin" },
    });

    const run = spawnSync(process.execPath, [res.path, "status", "--watch"], { encoding: "utf8" });
    assert.equal(run.status, 0);
    // …and it still runs the NEWEST one, with argv passed through untouched.
    assert.match(run.stdout, /VERSION 2\.2\.0 ARGS status,--watch/);
  });

  it("KEEPS WORKING after the plugin is upgraded behind its back (no reinstall)", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: "/usr/bin" },
    });

    const before = spawnSync(process.execPath, [res.path, "status"], { encoding: "utf8" });
    assert.match(before.stdout, /VERSION 2\.2\.0/);

    // Claude Code upgrades the plugin: a brand-new versioned dir appears.
    fakeCache(["2.10.0"]);

    const after = spawnSync(process.execPath, [res.path, "status"], { encoding: "utf8" });
    assert.match(after.stdout, /VERSION 2\.10\.0/,
      "the SAME launcher file must now resolve the new version — this is the whole point");
  });

  it("falls back to an older version rather than bricking on a half-written upgrade", () => {
    const pluginDir = fakeCache(["2.2.0", "2.3.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: "/usr/bin" },
    });

    // 2.3.0's dir exists but its script does not (an interrupted install).
    fs.rmSync(scriptIn(pluginDir, "2.3.0"));

    const run = spawnSync(process.execPath, [res.path, "status"], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /VERSION 2\.2\.0/);
  });

  it("propagates the child's exit code", () => {
    const pluginDir = fakeCache(["1.0.0"]);
    fs.writeFileSync(scriptIn(pluginDir, "1.0.0"), 'process.exit(3);\n');
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "1.0.0"),
      home, env: { PATH: "/usr/bin" },
    });

    const run = spawnSync(process.execPath, [res.path], { encoding: "utf8" });
    assert.equal(run.status, 3, "an `occ status` that fails must fail for the caller too");
  });

  it("fails with a real explanation when every version is gone", () => {
    const pluginDir = fakeCache(["2.2.0"]);
    const res = installCli({
      scriptPath: scriptIn(pluginDir, "2.2.0"),
      home, env: { PATH: "/usr/bin" },
    });
    fs.rmSync(pluginDir, { recursive: true, force: true });

    const run = spawnSync(process.execPath, [res.path, "status"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no installed plugin version found/);
  });
});
