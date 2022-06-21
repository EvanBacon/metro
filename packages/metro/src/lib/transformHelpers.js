/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

import type Bundler from '../Bundler';
import type DeltaBundler, {TransformFn} from '../DeltaBundler';
import type {
  TransformContextFn,
  TransformInputOptions,
} from '../DeltaBundler/types.flow';
import type {
  RequireContextParams,
  ContextMode,
} from '../ModuleGraph/worker/collectDependencies';
import type {TransformOptions} from '../DeltaBundler/Worker';
import type {ConfigT} from 'metro-config/src/configTypes.flow';
import type {Type} from 'metro-transform-worker';

import {getContextModuleId} from './contextModule';

const path = require('path');

type InlineRequiresRaw = {+blockList: {[string]: true, ...}, ...} | boolean;

type TransformOptionsWithRawInlines = {
  ...TransformOptions,
  +inlineRequires: InlineRequiresRaw,
};

const baseIgnoredInlineRequires = ['React', 'react', 'react-native'];

async function calcTransformerOptions(
  entryFiles: $ReadOnlyArray<string>,
  bundler: Bundler,
  deltaBundler: DeltaBundler<>,
  config: ConfigT,
  options: TransformInputOptions,
): Promise<TransformOptionsWithRawInlines> {
  const baseOptions = {
    customTransformOptions: options.customTransformOptions,
    dev: options.dev,
    hot: options.hot,
    inlineRequires: false,
    inlinePlatform: true,
    minify: options.minify,
    platform: options.platform,
    runtimeBytecodeVersion: options.runtimeBytecodeVersion,
    unstable_transformProfile: options.unstable_transformProfile,
  };

  // When we're processing scripts, we don't need to calculate any
  // inlineRequires information, since scripts by definition don't have
  // requires().
  if (options.type === 'script') {
    return {
      ...baseOptions,
      type: 'script',
    };
  }

  const getDependencies = async (path: string) => {
    const dependencies = await deltaBundler.getDependencies([path], {
      resolve: await getResolveDependencyFn(bundler, options.platform),
      transformContext: await getTransformContextFn(
        [path],
        bundler,
        deltaBundler,
        config,
        {
          ...options,
          minify: false,
        },
      ),
      transform: await getTransformFn([path], bundler, deltaBundler, config, {
        ...options,
        minify: false,
      }),
      transformOptions: options,
      onProgress: null,
      experimentalImportBundleSupport:
        config.transformer.experimentalImportBundleSupport,
      unstable_allowRequireContext:
        config.transformer.unstable_allowRequireContext,
      shallow: false,
    });

    return Array.from(dependencies.keys());
  };

  const {transform} = await config.transformer.getTransformOptions(
    entryFiles,
    {dev: options.dev, hot: options.hot, platform: options.platform},
    getDependencies,
  );

  return {
    ...baseOptions,
    inlineRequires: transform.inlineRequires || false,
    experimentalImportSupport: transform.experimentalImportSupport || false,
    unstable_disableES6Transforms:
      transform.unstable_disableES6Transforms || false,
    nonInlinedRequires:
      transform.nonInlinedRequires || baseIgnoredInlineRequires,
    type: 'module',
  };
}

function removeInlineRequiresBlockListFromOptions(
  path: string,
  inlineRequires: InlineRequiresRaw,
): boolean {
  if (typeof inlineRequires === 'object') {
    return !(path in inlineRequires.blockList);
  }

  return inlineRequires;
}

function createFileMap(
  modulePath: string,
  files: string[],
  processModule: (moduleId: string) => string,
) {
  let mapString = '';

  files.map(file => {
    let filePath = path.relative(modulePath, file);

    // NOTE(EvanBacon): I'd prefer we prevent the ability for a module to require itself (`require.context('./')`)
    // but Webpack allows this, keeping it here provides better parity between bundlers.

    // Ensure relative file paths start with `./` so they match the
    // patterns (filters) used to include them.
    if (!filePath.startsWith('.')) {
      filePath = `.${path.sep}` + filePath;
    }
    const key = JSON.stringify(filePath);
    // NOTE(EvanBacon): Webpack uses `require.resolve` in order to load modules on demand,
    // Metro doesn't have this functionality so it will use getters instead. Modules need to
    // be loaded on demand because if we imported directly then users would get errors from importing
    // a file without exports as soon as they create a new file and the context module is updated.

    // NOTE: The values are set to `enumerable` so the `context.keys()` method works as expected.
    mapString += `${key}: { enumerable: true, get() { return ${processModule(
      file,
    )}; } },`;
  });
  return `Object.defineProperties({}, {${mapString}})`;
}

function getEmptyContextModuleTemplate(modulePath: string, id: string): string {
  return `
function metroEmptyContext(request) {
  let e = new Error("No modules for context '" + ${JSON.stringify(id)} + "'");
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}

// Return the keys that can be resolved.
metroEmptyContext.keys = () => ([]);

// Return the module identifier for a user request.
metroEmptyContext.resolve = function metroContextResolve(request) {
  throw new Error('Unimplemented Metro module context functionality');
}

// Readable identifier for the context module.
metroEmptyContext.id = ${JSON.stringify(id)};

module.exports = metroEmptyContext;`;
}

function getLoadableContextModuleTemplate(
  modulePath: string,
  files: string[],
  id: string,
  importSyntax: string,
  getContextTemplate: string,
): string {
  return `// All of the requested modules are loaded behind enumerable getters.
const map = ${createFileMap(
    modulePath,
    files,
    moduleId => `${importSyntax}(${JSON.stringify(moduleId)})`,
  )};

function metroContext(request) {
${getContextTemplate}
}

// Return the keys that can be resolved.
metroContext.keys = function metroContextKeys() {
  return Object.keys(map);
};

// Return the module identifier for a user request.
metroContext.resolve = function metroContextResolve(request) {
  throw new Error('Unimplemented Metro module context functionality');
}

// Readable identifier for the context module.
metroContext.id = ${JSON.stringify(id)};

module.exports = metroContext;`;
}

function getContextModuleTemplate(
  mode: ContextMode,
  modulePath: string,
  files: string[],
  id: string,
): string {
  if (!files.length) {
    return getEmptyContextModuleTemplate(modulePath, id);
  }
  switch (mode) {
    case 'eager':
      return getLoadableContextModuleTemplate(
        modulePath,
        files,
        id,
        // NOTE(EvanBacon): It's unclear if we should use `import` or `require` here so sticking
        // with the more stable option (`require`) for now.
        'require',
        [
          '  // Here Promise.resolve().then() is used instead of new Promise() to prevent',
          '  // uncaught exception popping up in devtools',
          '  return Promise.resolve().then(() => map[request]);',
        ].join('\n'),
      );
    case 'sync':
      return getLoadableContextModuleTemplate(
        modulePath,
        files,
        id,
        'require',
        '  return map[request];',
      );
    case 'lazy':
    case 'lazy-once':
      return getLoadableContextModuleTemplate(
        modulePath,
        files,
        id,
        'import',
        '  return map[request];',
      );
    default:
      throw new Error(`Metro context mode "${mode}" is unimplemented`);
  }
}

import {fileMatchesContext} from './contextModule';
/** Generate the default method for transforming a `require.context` module. */
async function getTransformContextFn(
  entryFiles: $ReadOnlyArray<string>,
  bundler: Bundler,
  deltaBundler: DeltaBundler<>,
  config: ConfigT,
  options: TransformInputOptions,
): Promise<TransformContextFn<>> {
  const {inlineRequires, ...transformOptions} = await calcTransformerOptions(
    entryFiles,
    bundler,
    deltaBundler,
    config,
    options,
  );

  // Cache all of the modules for intermittent updates.
  const moduleCache = {};

  return async (modulePath: string, requireContext: RequireContextParams) => {
    const graph = await bundler.getDependencyGraph();

    // TODO: do this earlier, prefer right after serialized.
    const filter = new RegExp(
      requireContext.filter.pattern,
      requireContext.filter.flags,
    );

    console.time('match-context-' + modulePath);
    let files = [];
    if (modulePath in moduleCache && requireContext.delta) {
      // Get the cached modules
      files = moduleCache[modulePath];

      // Remove files from the cache.
      const deletedFiles = requireContext.delta.deletedFiles;
      if (deletedFiles.size) {
        files = files.filter(filePath => !deletedFiles.has(filePath));
      }

      // Add files to the cache.
      const addedFiles = requireContext.delta.addedFiles;
      addedFiles.forEach(filePath => {
        if (
          !files.includes(filePath) &&
          fileMatchesContext(modulePath, filePath, {
            recursive: requireContext.recursive,
            filter,
          })
        ) {
          files.push(filePath);
        }
      });
    } else {
      // Search against all files, this is very expensive.
      // TODO: Maybe we could let the user specify which root to check against.
      files = graph.matchFilesWithContext(modulePath, {
        recursive: requireContext.recursive,
        filter,
      });
    }

    moduleCache[modulePath] = files;

    console.timeEnd('match-context-' + modulePath);

    const template = getContextModuleTemplate(
      requireContext.mode,
      modulePath,
      files,
      getContextModuleId(modulePath, requireContext),
    );
    return await bundler.transformFile(
      modulePath,
      {
        ...transformOptions,
        type: getType(
          transformOptions.type,
          modulePath,
          config.resolver.assetExts,
        ),
        inlineRequires: removeInlineRequiresBlockListFromOptions(
          modulePath,
          inlineRequires,
        ),
      },
      Buffer.from(template),
    );
  };
}

async function getTransformFn(
  entryFiles: $ReadOnlyArray<string>,
  bundler: Bundler,
  deltaBundler: DeltaBundler<>,
  config: ConfigT,
  options: TransformInputOptions,
): Promise<TransformFn<>> {
  const {inlineRequires, ...transformOptions} = await calcTransformerOptions(
    entryFiles,
    bundler,
    deltaBundler,
    config,
    options,
  );

  return async (path: string) => {
    return await bundler.transformFile(path, {
      ...transformOptions,
      type: getType(transformOptions.type, path, config.resolver.assetExts),
      inlineRequires: removeInlineRequiresBlockListFromOptions(
        path,
        inlineRequires,
      ),
    });
  };
}

function getType(
  type: string,
  filePath: string,
  assetExts: $ReadOnlyArray<string>,
): Type {
  if (type === 'script') {
    return type;
  }

  if (assetExts.indexOf(path.extname(filePath).slice(1)) !== -1) {
    return 'asset';
  }

  return 'module';
}

async function getResolveDependencyFn(
  bundler: Bundler,
  platform: ?string,
): Promise<(from: string, to: string) => string> {
  const dependencyGraph = await await bundler.getDependencyGraph();

  return (from: string, to: string) =>
    // $FlowFixMe[incompatible-call]
    dependencyGraph.resolveDependency(from, to, platform);
}

module.exports = {
  getTransformFn,
  getTransformContextFn,
  getResolveDependencyFn,
};
