/**
 * create-aperture-app: scaffold a paid API or MCP server on CF Workers.
 *
 * Usage: npx create-aperture-app [project-name] [--template rest|mcp]
 */

import { mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = ["rest-worker", "mcp-worker"] as const;
type Template = (typeof TEMPLATES)[number];

function main() {
  const args = process.argv.slice(2);
  const projectName = args[0] ?? "my-aperture-app";
  const templateFlag = args.find((a) => a.startsWith("--template="));
  const template: Template = (templateFlag?.split("=")[1] as Template) ?? "rest-worker";

  if (!TEMPLATES.includes(template)) {
    console.error(`Unknown template: ${template}. Choose: ${TEMPLATES.join(", ")}`);
    process.exit(1);
  }

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const templateDir = join(thisDir, "..", "templates", template);
  const targetDir = join(process.cwd(), projectName);

  console.log(`Creating ${projectName} from template: ${template}`);

  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });

  // Write package.json with project name.
  const pkgJson = {
    name: projectName,
    version: "0.0.1",
    type: "module",
    scripts: {
      dev: "wrangler dev",
      deploy: "wrangler deploy",
    },
    dependencies: {
      "@lightninglabs/aperture-core": "workspace:*",
      "@lightninglabs/aperture-http": "workspace:*",
    },
    devDependencies: {
      wrangler: "^4.0.0",
      typescript: "^5.7.0",
    },
  };
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify(pkgJson, null, 2) + "\n",
  );

  console.log(`\nDone! Next steps:`);
  console.log(`  cd ${projectName}`);
  console.log(`  pnpm install`);
  console.log(`  pnpm dev`);
}

main();
