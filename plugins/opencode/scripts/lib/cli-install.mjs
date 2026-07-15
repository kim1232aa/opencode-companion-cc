// The `occ` CLI launcher: a short command on PATH instead of
//   node ~/.claude/plugins/cache/opencode-companion-cc/opencode/2.2.0/scripts/opencode-companion.mjs status
//
// The hard requirement is that the launcher NEVER pins a version. Claude Code
// installs each plugin release into its own versioned directory, so a launcher
// that baked in "2.2.0" would break on the next upgrade — silently, and in a way
// that looks like the plugin itself is broken. So the generated launcher scans
// the plugin's cache dir and picks the newest version AT RUN TIME, every time.
//
// Every filesystem/env seam is injectable so the tests can install into a
// throwaway HOME instead of the user's real ~/.local/bin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Default command name.
 *
 * NOT `oc`: that is the OpenShift CLI, which is on a lot of PATHs already, and
 * shadowing it would be a hostile thing for a plugin to do.
 */
export const DEFAULT_CLI_NAME = "occ";

// Stamped into every launcher we generate. It is what lets `--uninstall-cli`
// (and a reinstall) tell OUR file apart from some unrelated binary that happens
// to share the name — we will never delete or overwrite a file we did not write.
export const LAUNCHER_MARKER = "opencode-companion-cli-launcher";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Compare two version dir names newest-last (Array#sort order).
 * Numeric per segment (so 2.10.0 > 2.9.0, which a string sort gets wrong), and a
 * prerelease sorts BELOW its own release (2.3.0-rc.1 < 2.3.0).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return String(a).localeCompare(String(b));

  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;  // release beats its own prerelease
  if (pb === undefined) return -1;
  return pa.localeCompare(pb);
}

/**
 * The newest version among a list of directory names. Non-semver names are
 * ignored outright, so a stray `.DS_Store` or a `tmp` dir can never win.
 * @param {string[]} names
 * @returns {string|null}
 */
export function pickLatestVersion(names = []) {
  const versions = names.filter((n) => SEMVER_RE.test(n));
  if (!versions.length) return null;
  return versions.sort(compareVersions)[versions.length - 1];
}

/**
 * Work out what this running script IS, so the launcher can be pointed at the
 * right thing:
 *   - "plugin":   installed by Claude Code at
 *                 <root>/plugins/cache/<owner-repo>/<plugin>/<version>/scripts/…
 *                 ⇒ the launcher scans <root>/plugins/cache/<owner-repo>/<plugin>/
 *                 and resolves the newest version on every run.
 *   - "checkout": a dev/source tree ⇒ there are no sibling versions to choose
 *                 between, so the launcher points straight at this file.
 * The owner/repo/plugin names are DERIVED, never hardcoded, so a fork or a
 * differently-named marketplace entry installs a working launcher too.
 *
 * @param {string} scriptPath - absolute path to opencode-companion.mjs
 * @returns {{ kind: "plugin"|"checkout", pluginDir: string|null, scriptPath: string }}
 */
export function resolveInstallSource(scriptPath) {
  const parts = scriptPath.split(path.sep);
  const cacheIdx = parts.lastIndexOf("cache");
  // Need <cache>/<owner-repo>/<plugin>/<version>/… below it to be a real install.
  if (cacheIdx > 0 && parts.length > cacheIdx + 4) {
    return {
      kind: "plugin",
      pluginDir: parts.slice(0, cacheIdx + 3).join(path.sep),
      scriptPath,
    };
  }
  return { kind: "checkout", pluginDir: null, scriptPath };
}

/**
 * Generate the launcher.
 *
 * It is a CommonJS Node script (an extensionless file in ~/.local/bin is CJS to
 * Node, and node is a hard dependency of the plugin anyway) rather than a shell
 * script, because the one thing it must get right — semver ordering — is exactly
 * what portable `sh` is worst at (`sort -V` is not portable to macOS).
 *
 * It EXECS the real script rather than importing it: the entry-point guard in
 * opencode-companion.mjs keys off process.argv[1], so an import would load the
 * module and then run nothing at all. Stdio is inherited so the `watch` panel
 * keeps its TTY (and its in-place repaint).
 *
 * @param {{ pluginDir: string|null, scriptPath: string|null }} source
 * @returns {string}
 */
export function renderLauncher(source) {
  const pluginDir = source.pluginDir ? JSON.stringify(source.pluginDir) : "null";
  // A checkout install has no sibling versions, so it — and only it — hardcodes
  // a path. A plugin install must stay version-agnostic forever, so it does NOT
  // get a fallback that could silently pin it to today's release.
  const fallback = source.pluginDir ? "null" : JSON.stringify(source.scriptPath);

  return `#!/usr/bin/env node
// ${LAUNCHER_MARKER} — generated by \`opencode-companion setup --install-cli\`.
// DO NOT EDIT. Re-run \`setup --install-cli\` to regenerate, \`setup --uninstall-cli\` to remove.
//
// Resolves the NEWEST INSTALLED plugin version at RUN TIME. No version is baked
// in, so upgrading the plugin can never leave this launcher pointing at a path
// that no longer exists.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_DIR = ${pluginDir};
const FALLBACK_SCRIPT = ${fallback};

const SEMVER_RE = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$/;

function compareVersions(a, b) {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return String(a).localeCompare(String(b));
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa.localeCompare(pb);
}

function resolveScript() {
  if (PLUGIN_DIR) {
    let names = [];
    try {
      names = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => SEMVER_RE.test(n));
    } catch { /* fall through to the error below */ }

    names.sort(compareVersions);
    // Newest first, but keep walking down: a half-written upgrade must not brick
    // the command when a perfectly good older version is sitting right there.
    for (let i = names.length - 1; i >= 0; i--) {
      const candidate = path.join(PLUGIN_DIR, names[i], "scripts", "opencode-companion.mjs");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (FALLBACK_SCRIPT && fs.existsSync(FALLBACK_SCRIPT)) return FALLBACK_SCRIPT;
  return null;
}

const script = resolveScript();
if (!script) {
  console.error(
    "opencode-companion: no installed plugin version found" +
    (PLUGIN_DIR ? \` under \${PLUGIN_DIR}\` : "") +
    ".\\nIs the plugin still installed? Reinstall it, then re-run \`setup --install-cli\`."
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.error) {
  console.error(\`opencode-companion: failed to run \${script}: \${res.error.message}\`);
  process.exit(1);
}
if (typeof res.status === "number") process.exit(res.status);
// Killed by a signal (status null, signal set): exit 128 + signum, the
// conventional "terminated by signal" code — never mask a SIGTERM/SIGKILL of the
// delegated run as a clean exit 0. Bare non-zero if the number can't be resolved.
const signum = res.signal ? require("node:os").constants.signals[res.signal] : 0;
process.exit(signum ? 128 + signum : 1);
`;
}

/** The PATH, split into directories. */
function pathDirs(env) {
  return String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

/** Whether a file exists and is executable. */
function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a file is a launcher WE generated (never trust the name alone). */
export function isOurLauncher(file, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  try {
    return readFile(file).includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
}

/**
 * Is this command name already taken by something that ISN'T ours?
 *
 * The `command -v` check, done in-process: an existing `occ` earlier on PATH
 * would shadow ours (or ours would shadow theirs), and either way the user must
 * be told and offered `--cli-name` rather than having a collision installed
 * behind their back.
 *
 * @param {string} name
 * @param {{ env?: object, io?: object }} [opts]
 * @returns {string|null} the conflicting path, or null
 */
export function findCommandConflict(name, opts = {}) {
  const env = opts.env ?? process.env;
  const io = opts.io ?? {};
  const exists = io.isExecutableFile ?? isExecutableFile;

  for (const dir of pathDirs(env)) {
    const candidate = path.join(dir, name);
    if (!exists(candidate)) continue;
    if (isOurLauncher(candidate, io)) continue; // our own previous install: that's an update
    return candidate;
  }
  return null;
}

/** A copy-pasteable one-liner that puts binDir on PATH permanently. */
export function pathHint(binDir, env = process.env, home = os.homedir()) {
  const shell = path.basename(String(env.SHELL ?? "bash"));
  const rc = shell === "zsh" ? ".zshrc" : shell === "fish" ? ".config/fish/config.fish" : ".bashrc";
  const rcPath = path.join(home, rc);
  const pretty = binDir.startsWith(home) ? binDir.replace(home, "$HOME") : binDir;

  if (shell === "fish") {
    return `fish_add_path ${pretty}`;
  }
  return `echo 'export PATH="${pretty}:$PATH"' >> ${rcPath} && source ${rcPath}`;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Install the launcher. Idempotent: reinstalling just overwrites our own file.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath - absolute path of the running opencode-companion.mjs
 * @param {string} [opts.name] - command name (default "occ")
 * @param {string} [opts.home] - HOME (tests point this at a temp dir)
 * @param {object} [opts.env]
 * @param {string} [opts.binDir] - override the install dir (default <home>/.local/bin)
 * @param {object} [opts.io] - injectable fs seams
 * @returns {{ path: string, name: string, action: "installed"|"updated", source: object,
 *            onPath: boolean, hint: string|null }}
 */
export function installCli(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const name = String(opts.name || DEFAULT_CLI_NAME);
  const binDir = opts.binDir ?? path.join(home, ".local", "bin");
  const io = opts.io ?? {};

  const mkdir = io.mkdir ?? ((d) => fs.mkdirSync(d, { recursive: true }));
  const writeFile = io.writeFile ?? ((p, c) => fs.writeFileSync(p, c, { mode: 0o755 }));
  const chmod = io.chmod ?? ((p, m) => fs.chmodSync(p, m));
  const exists = io.exists ?? ((p) => fs.existsSync(p));

  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid CLI name "${name}". Use letters, digits, dot, dash or underscore.`);
  }

  const target = path.join(binDir, name);
  const targetExists = exists(target);

  // Someone else's command with this name — anywhere on PATH — is a hard stop.
  const conflict = findCommandConflict(name, { env, io });
  if (conflict && conflict !== target) {
    throw new Error(
      `\`${name}\` is already on your PATH at ${conflict}.\n` +
      `Refusing to shadow it. Install under a different name:\n` +
      `  setup --install-cli --cli-name <name>`
    );
  }
  // A foreign file sitting at the exact target path: same story, but the message
  // has to be about the FILE, since it may not even be executable.
  if (targetExists && !isOurLauncher(target, io)) {
    throw new Error(
      `${target} already exists and was not created by this plugin.\n` +
      `Refusing to overwrite it. Install under a different name:\n` +
      `  setup --install-cli --cli-name <name>`
    );
  }

  const source = resolveInstallSource(opts.scriptPath);
  mkdir(binDir);
  writeFile(target, renderLauncher(source));
  chmod(target, 0o755);

  const onPath = pathDirs(env).includes(binDir);
  return {
    path: target,
    name,
    action: targetExists ? "updated" : "installed",
    source,
    onPath,
    hint: onPath ? null : pathHint(binDir, env, home),
  };
}

/**
 * Remove a launcher we installed. Refuses to delete anything we did not write —
 * an uninstall must never be able to eat an unrelated binary that happens to
 * share the name.
 *
 * @param {object} opts - name/home/binDir/io, as installCli
 * @returns {{ path: string, action: "removed"|"absent" }}
 */
export function uninstallCli(opts = {}) {
  const home = opts.home ?? os.homedir();
  const name = String(opts.name || DEFAULT_CLI_NAME);
  const binDir = opts.binDir ?? path.join(home, ".local", "bin");
  const io = opts.io ?? {};

  const exists = io.exists ?? ((p) => fs.existsSync(p));
  const unlink = io.unlink ?? ((p) => fs.unlinkSync(p));

  const target = path.join(binDir, name);
  if (!exists(target)) return { path: target, action: "absent" };

  if (!isOurLauncher(target, io)) {
    throw new Error(
      `${target} was not created by this plugin — refusing to delete it.\n` +
      `If you installed the launcher under another name, pass --cli-name <name>.`
    );
  }

  unlink(target);
  return { path: target, action: "removed" };
}
