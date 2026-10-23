import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateOpenApi } from './openapi.js';

export const OPENAPI_PATH = fileURLToPath(
  new URL('../../../packages/shared/openapi.json', import.meta.url),
);

await writeFile(OPENAPI_PATH, await generateOpenApi());
process.stdout.write(`OpenAPI geschrieben: ${OPENAPI_PATH}\n`);
