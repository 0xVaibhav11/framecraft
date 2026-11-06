import { mkdir, readFile, realpath, symlink, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Optional offline bootstrap. A normal workspace install can supply these same declared dependencies.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: npm run poc:bootstrap -- /path/to/existing/node_modules"
  );
const expected = {
  next: "16.3.1",
  react: "19.2.8",
  "react-dom": "19.2.8",
  "@types/node": "20.19.43",
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.4",
};
async function link(target, destination) {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await lstat(destination);
    if ((await realpath(destination)) === (await realpath(target))) return;
    throw new Error(`Refusing to replace ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(await realpath(target), destination);
}
for (const [name, version] of Object.entries(expected)) {
  const target = resolve(source, name);
  const pkg = JSON.parse(
    await readFile(resolve(target, "package.json"), "utf8")
  );
  if (pkg.version !== version)
    throw new Error(`${name}: expected ${version}, found ${pkg.version}`);
  await link(target, resolve(root, "apps/poc/node_modules", name));
}
await link(
  resolve(root, "apps/poc/node_modules/next/dist/bin/next"),
  resolve(root, "apps/poc/node_modules/.bin/next")
);
console.log(
  "Linked installed frontend dependencies without modifying the source checkout."
);
