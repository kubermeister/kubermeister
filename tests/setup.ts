import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No test may ever see the developer's real kubeconfig. Point the default lookup at a file that
// does not exist inside a fresh temp directory: any code path that loads the default kubeconfig
// fails loudly instead of finding ~/.kube/config.
process.env.KUBECONFIG = join(mkdtempSync(join(tmpdir(), 'km-unit-')), 'nonexistent-kubeconfig');

// Nor the developer's own settings file: the store resolves it from these before the home
// directory, so pointing both into a fresh temp directory keeps every test that forgets to name its
// own file away from ~/.config/kubermeister.
const configHome = mkdtempSync(join(tmpdir(), 'km-config-'));
process.env.XDG_CONFIG_HOME = configHome;
process.env.KUBERMEISTER_CONFIG = join(configHome, 'kubermeister', 'settings.json');
delete process.env.KUBERMEISTER_USER_DATA;
