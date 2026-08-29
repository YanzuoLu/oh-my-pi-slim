import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function findPiRoot(entry) {
  let directory = dirname(entry);

  while (true) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.name === PI_PACKAGE_NAME) return realpathSync(directory);
    }

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not find ${PI_PACKAGE_NAME} package root from ${entry}`);
    directory = parent;
  }
}

export const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
export const piRoot = findPiRoot(piEntry);
