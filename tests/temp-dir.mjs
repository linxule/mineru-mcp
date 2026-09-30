import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// macOS may expose the system temp directory through a symlink. Keep fixture
// paths canonical so the production no-follow checks run on both macOS/Linux.
export const temporaryPrefix = prefix => join(realpathSync(tmpdir()),prefix);
