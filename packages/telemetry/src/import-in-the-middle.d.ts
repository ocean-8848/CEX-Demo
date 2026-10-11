// The package ships `register-hooks.d.ts`, which TypeScript does not pick up
// for the `.mjs` specifier under NodeNext resolution.
declare module "import-in-the-middle/register-hooks.mjs" {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
    disableCjsSourceStripping?: boolean;
  }): void;
  export function supportsSyncHooks(): boolean;
}
