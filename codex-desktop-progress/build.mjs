/** Build a signed local desktop copy, preserving the stock app and its updater. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gatewayPath } from "../codex_cloud_config.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] || "/Applications/ChatGPT.app");
const destination = path.resolve(
	process.argv[3] || path.join(os.homedir(), "Applications/ChatGPT Local.app"),
);
if (fs.existsSync(destination))
	throw new Error("Destination exists; choose a new app destination.");
const scratch = fs.mkdtempSync("/private/tmp/codex-desktop-progress-");
const run = (command, args) => {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(command + " failed: " + result.status);
};
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sourceArchive = path.join(source, "Contents/Resources/app.asar");
const fd = fs.openSync(sourceArchive, "r");
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, 16, 0);
const headerBytes = Buffer.alloc(prefix.readUInt32LE(12));
fs.readSync(fd, headerBytes, 0, headerBytes.length, 16);
const header = JSON.parse(headerBytes);
const sourceDataOffset = 8 + prefix.readUInt32LE(4);
const get = (name) =>
	name.split("/").reduce((node, key) => node.files[key], header);
const read = (name) => {
	const entry = get(name),
		buffer = Buffer.alloc(Number(entry.size));
	fs.readSync(
		fd,
		buffer,
		0,
		buffer.length,
		sourceDataOffset + Number(entry.offset),
	);
	return buffer;
};
try {
	const esbuild = path.join(gatewayPath("pi_root", "CODEX_PI_ROOT"), "node_modules/.bin/esbuild");
	const proxyKeyFile = path.join(
		gatewayPath("agent_dir", "CODEX_PI_AGENT_DIR", path.dirname(directory)),
		".proxy-key",
	);
	for (const [name, format] of [
		["main", "cjs"],
		["preload", "iife"],
	]) {
		run(esbuild, [
			path.join(directory, name + ".ts"),
			"--bundle",
			"--platform=node",
			"--external:electron",
			"--format=" + format,
			...(name === "main" ? ["--define:LOCAL_PROGRESS_PROXY_KEY_FILE=" + JSON.stringify(proxyKeyFile)] : []),
			"--outfile=" + path.join(scratch, name + ".cjs"),
		]);
	}
	const main = JSON.parse(read("package.json")).main.replace(/^\.\//, "");
	const preload = ".vite/build/preload.js";
	const additions = new Map([
		[
			main,
			Buffer.concat([
				Buffer.from('require("./local-llm-main.cjs");\n'),
				read(main),
			]),
		],
		[
			preload,
			Buffer.concat([
				read(preload),
				Buffer.from("\n;"),
				fs.readFileSync(path.join(scratch, "preload.cjs")),
			]),
		],
		[
			".vite/build/local-llm-main.cjs",
			fs.readFileSync(path.join(scratch, "main.cjs")),
		],
	]);
	// This copy is rebuilt from the stock app; vendor updates belong to stock.
	for (const name of Object.keys(header.files[".vite"].files.build.files)) {
		if (!name.startsWith("early-bootstrap") || !name.endsWith(".js")) continue;
		const filename = ".vite/build/" + name;
		const original = read(filename).toString();
		const patched = original.replace(
			/enableUpdater:[\w$.]+\.shouldIncludeUpdater\([^)]*\)/g,
			"enableUpdater:false",
		);
		if (patched !== original) additions.set(filename, Buffer.from(patched));
	}
	// Keep catalog names verbatim; Codex otherwise reformats every GPT-prefixed name.
	let modelNameFormatterFound = false;
	for (const name of Object.keys(header.files.webview.files.assets.files.async.files)) {
		if (!name.endsWith(".js")) continue;
		const filename = "webview/assets/async/" + name;
		const original = read(filename).toString();
		const patched = original.replace(
			/function ([\w$]+)\(([\w$]+),\{stripGptPrefix:[\w$]+=!1\}=\{\}\)\{.*?return [\w$]+\?[\w$]+\.replace\(\/\^GPT-\/iu,""\):[\w$]+\}/g,
			(_, functionName, argument) => {
				modelNameFormatterFound = true;
				return `function ${functionName}(${argument}){return ${argument}}`;
			},
		);
		if (patched !== original) additions.set(filename, Buffer.from(patched));
	}
	if (!modelNameFormatterFound)
		throw new Error("Could not find the desktop model-name formatter");
	// ASAR keeps per-file integrity; rebuild only changed files' integrity blocks.
	for (const [name, buffer] of additions) {
		const parts = name.split("/");
		let node = header;
		for (const key of parts.slice(0, -1))
			node = node.files[key] ||= { files: {} };
		const blockSize = 4 * 1024 * 1024,
			blocks = [];
		for (let at = 0; at < buffer.length; at += blockSize)
			blocks.push(sha(buffer.subarray(at, at + blockSize)));
		node.files[parts.at(-1)] = {
			size: buffer.length,
			offset: "0",
			integrity: { algorithm: "SHA256", hash: sha(buffer), blockSize, blocks },
		};
	}
	const files = [];
	let offset = 0;
	function collect(node, base = "") {
		for (const [key, entry] of Object.entries(node.files || {})) {
			const name = base ? base + "/" + key : key;
			if (entry.files) collect(entry, name);
			else if (!entry.unpacked && !entry.link) {
				files.push({
					name,
					sourceOffset: Number(entry.offset),
					size: Number(entry.size),
				});
				entry.offset = String(offset);
				offset += Number(entry.size);
			}
		}
	}
	collect(header);
	const json = Buffer.from(JSON.stringify(header));
	const payloadLength = Math.ceil((4 + json.length + 1) / 4) * 4;
	const pickle = Buffer.alloc(4 + payloadLength);
	pickle.writeUInt32LE(payloadLength, 0);
	pickle.writeUInt32LE(json.length, 4);
	json.copy(pickle, 8);
	const size = Buffer.alloc(8);
	size.writeUInt32LE(4, 0);
	size.writeUInt32LE(pickle.length, 4);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	// macOS clonefile creates independent copy-on-write app files, not hard links.
	run("/bin/cp", ["-cR", source, destination]);
	const archive = path.join(destination, "Contents/Resources/app.asar");
	const output = fs.openSync(archive + ".building", "w");
	try {
		fs.writeSync(output, size);
		fs.writeSync(output, pickle);
		const chunk = Buffer.alloc(1024 * 1024);
		for (const file of files) {
			const replacement = additions.get(file.name);
			if (replacement) {
				fs.writeSync(output, replacement);
				continue;
			}
			let remaining = file.size,
				at = sourceDataOffset + file.sourceOffset;
			while (remaining) {
				const count = fs.readSync(
					fd,
					chunk,
					0,
					Math.min(chunk.length, remaining),
					at,
				);
				if (!count) throw new Error("Unexpected end of source archive");
				fs.writeSync(output, chunk, 0, count);
				at += count;
				remaining -= count;
			}
		}
	} finally {
		fs.closeSync(output);
	}
	fs.renameSync(archive + ".building", archive);
	const plist = path.join(destination, "Contents/Info.plist");
	run("/usr/libexec/PlistBuddy", [
		"-c",
		"Set :ElectronAsarIntegrity:Resources/app.asar:hash " + sha(json),
		plist,
	]);
	run("/usr/libexec/PlistBuddy", [
		"-c",
		"Set :CFBundleDisplayName ChatGPT Local",
		plist,
	]);
	// Electron also seals the entire Info.plist integrity dictionary in its framework.
	// Format: electron/shell/common/asar/integrity_digest.mm (used, version, SHA256).
	const integrityResult = spawnSync("/usr/bin/plutil", [
		"-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist,
	], { encoding: "utf8" });
	if (integrityResult.status !== 0)
		throw new Error("Could not read the app's ASAR integrity dictionary");
	const integrity = JSON.parse(integrityResult.stdout);
	const hasher = crypto.createHash("sha256");
	for (const name of Object.keys(integrity).sort())
		hasher.update(name).update(integrity[name].algorithm).update(integrity[name].hash);
	const digest = hasher.digest();
	const framework = path.join(destination, "Contents/Frameworks/Codex Framework.framework");
	const frameworkBinary = path.join(framework, "Codex Framework");
	const image = fs.readFileSync(frameworkBinary);
	const sentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
	let at = image.indexOf(sentinel);
	if (at < 0) throw new Error("Framework has no embedded ASAR integrity digest slot");
	// Universal frameworks carry a slot in each architecture slice.
	while (at >= 0) {
		const slot = at + sentinel.length;
		if (image[slot] !== 1 || image[slot + 1] !== 1)
			throw new Error("Unsupported embedded ASAR integrity digest format");
		digest.copy(image, slot + 2);
		at = image.indexOf(sentinel, slot + 2 + digest.length);
	}
	fs.writeFileSync(frameworkBinary, image);

	// Local ad-hoc signing cannot retain Apple's restricted account/group entitlements.
	function signApp(bundle) {
		const entitlementResult = spawnSync(
			"/usr/bin/codesign",
			["-d", "--entitlements", ":-", bundle],
			{ encoding: "utf8" },
		);
		if (entitlementResult.status !== 0)
			throw new Error("Could not read signing entitlements: " + bundle);
		const entitlements = path.join(scratch, "entitlements.plist");
		fs.writeFileSync(entitlements, entitlementResult.stdout);
		for (const key of [
			"com.apple.application-identifier",
			"com.apple.developer.team-identifier",
			"com.apple.developer.aps-environment",
			"com.apple.developer.associated-domains",
			"com.apple.developer.usernotifications.communication",
			"com.apple.security.application-groups",
			"keychain-access-groups",
			"com.apple.security.cs.disable-library-validation",
		]) {
			spawnSync("/usr/libexec/PlistBuddy", [
				"-c",
				"Delete :" + key,
				entitlements,
			]);
		}
		run("/usr/libexec/PlistBuddy", [
			"-c",
			"Add :com.apple.security.cs.disable-library-validation bool true",
			entitlements,
		]);
		run("/usr/bin/codesign", [
			"--force",
			"--sign",
			"-",
			"--options",
			"runtime",
			"--entitlements",
			entitlements,
			bundle,
		]);
	}
	// Helpers must be able to load the locally signed framework. Sign inside-out.
	const helpers = path.join(framework, "Versions/Current/Helpers");
	for (const name of fs.readdirSync(helpers))
		if (name.endsWith(".app")) signApp(path.join(helpers, name));
	run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", framework]);
	signApp(destination);
	console.log("Built native local progress app: " + destination);
} finally {
	fs.closeSync(fd);
	fs.rmSync(scratch, { recursive: true, force: true });
}
