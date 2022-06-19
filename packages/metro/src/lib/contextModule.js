import crypto from 'crypto';

import type {
  RequireContextParams,
} from '../ModuleGraph/worker/collectDependencies';

/** Get an ID for a context module. */
export function getContextModuleId(modulePath: string, context: RequireContextParams): string {
    // Similar to other `require.context` implementations.
    return [
      modulePath,
      context.mode,
      context.recursive ? 'recursive' : '',
      new RegExp(context.filter.pattern, context.filter.flags).toString(),
    ]
      .filter(Boolean)
      .join(' ');
}

function toHash(value: string): string {
    return crypto.createHash('sha1').update(value).digest('hex');
}

export function removeContextQueryParam(virtualFilePath: string): string {
    const [filepath] = virtualFilePath.split('?ctx=');
    return filepath;
}

export function appendContextQueryParam(filePath: string, context: RequireContextParams): string {
    return filePath + '?ctx=' + toHash(getContextModuleId(filePath, context));
}

export function fileMatchesContext(
    inputPath: string,
    testPath: string,
    context: $ReadOnly<{
      /* Should search for files recursively. */
      recursive: boolean,
      /* Filter relative paths against a pattern. */
      filter: RegExp,
    }>,
) {
  
    const filePath = path.relative(inputPath, testPath);
  
    console.log('test file:', testPath, '->', inputPath);
    console.log('- relative:', filePath);
    if (
      // Ignore everything outside of the provided `root`.
      !(filePath && !filePath.startsWith('..') && !path.isAbsolute(filePath)) ||
      // Prevent searching in child directories during a non-recursive search.
      (!context.recursive && filePath.includes(path.sep)) ||
      // Test against the filter.
      !context.filter.test(filePath)
    ) {
      return false;
    }
  
    return true;
  }