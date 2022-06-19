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

    // Prevent require cycles.
    if (filePath) {
      // Ensure we have the starting `./`
      if (!filePath.startsWith('.')) {
        filePath = `.${path.sep}` + filePath;
      }
      const key = JSON.stringify(filePath);
      mapString += `${key}: { enumerable: true, get() { return ${processModule(
        file,
      )}; } },`;
    }
  });
  return `Object.defineProperties({}, {${mapString}})`;
}

function getSyncContextModuleTemplate(
  modulePath: string,
  files: string[],
  id: string,
): string {
  // TODO: All source types https://github.com/webpack/webpack/blob/e2f1592f7e4d8f0578e5bb23d6a863b4a2b5f309/lib/ContextModule.js#L741
  return `
  // All of the requested modules which are loaded behind getters.
  const map = ${createFileMap(
    modulePath,
    files,
    moduleId => `require(${JSON.stringify(moduleId)})`,
  )};

  function metroContext(request) {
    return map[key];
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
  switch (mode) {
    case 'sync':
      return getSyncContextModuleTemplate(modulePath, files, id);
    default:
      throw new Error(`Metro context mode "${mode}" is unimplemented`);
  }
}

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

  return async (modulePath: string, requireContext: RequireContextParams) => {
    const graph = await bundler.getDependencyGraph();
    const filter = new RegExp(
      requireContext.filter.pattern,
      requireContext.filter.flags,
    );
    const files = graph.matchFilesWithContext(modulePath, {
      recursive: requireContext.recursive,
      filter,
    });

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
