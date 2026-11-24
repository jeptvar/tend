// Makes a package fail to load, the way one does when its part for this computer is missing.
// Node loads this before Tend, with --import: BLOCK_PACKAGE is the package, and BLOCK_MESSAGE
// is what it says.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === process.env.BLOCK_PACKAGE) throw new Error(process.env.BLOCK_MESSAGE);
    return nextResolve(specifier, context);
  },
});
