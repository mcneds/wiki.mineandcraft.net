import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const child = spawn(windows ? process.env.ComSpec || 'cmd.exe' : 'sh', windows ? ['/d', '/s', '/c', 'gradlew.bat build'] : ['gradlew', 'build'], {
  cwd: fileURLToPath(new URL('../server/mapart-bridge/', import.meta.url)), stdio: 'inherit',
});
child.on('error', error => { console.error(`Mapart build could not start: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
