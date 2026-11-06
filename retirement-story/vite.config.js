import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Story uses the source financial model, not a duplicated or cached calculation.
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
export default defineConfig({
 root:'app',
 base:'./',
 server:{fs:{allow:[repositoryRoot]}},
 build:{outDir:'../dist',emptyOutDir:true},
});
