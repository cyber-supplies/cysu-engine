// Local reset: protected routes stay locked until the installer provisions again.
import { load, remove } from './store.js';

const auth = await load('auth', {});
await remove('auth');
console.log(auth.token ? 'Engine token removed.' : 'No engine token is set: nothing to reset.');
console.log('Protected routes are locked. Run install.sh --token <user token> on the engine host to restore access.');
