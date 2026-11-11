// The tests run the sources themselves, and the sources import each other the way `tsc` writes it:
// `./providers/base.js` for the file next door that is still `base.ts`. Node reads a `.ts` file
// directly and strips its types, but it does not try the other extension for a specifier that names
// nothing, so every suite here failed at its first import. This hook answers exactly that case,
// which lets a test import the file it means to test rather than the build.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
