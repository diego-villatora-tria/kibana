/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const path = require('path');
const webpack = require('webpack');
const { stringifyRequest } = require('loader-utils');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { DLL_OUTPUT, KIBANA_ROOT } = require('./constants');

// Extend the Storybook Webpack config with some customizations
module.exports = async ({ config }) => {
  // Find and alter the CSS rule to replace the Kibana public path string with a path
  // to the route we've added in middleware.js
  const cssRule = config.module.rules.find((rule) => rule.test.source.includes('.css$'));
  cssRule.use.push({
    loader: 'string-replace-loader',
    options: {
      search: '__REPLACE_WITH_PUBLIC_PATH__',
      replace: '/',
      flags: 'g',
    },
  });

  // Include the React preset from Kibana for Storybook JS files.
  config.module.rules.push({
    test: /\.js$/,
    exclude: /node_modules/,
    loaders: 'babel-loader',
    options: {
      presets: [require.resolve('@kbn/babel-preset/webpack_preset')],
    },
  });

  // Handle Typescript files
  config.module.rules.push({
    test: /\.tsx?$/,
    use: [
      {
        loader: 'babel-loader',
        options: {
          presets: [require.resolve('@kbn/babel-preset/webpack_preset')],
        },
      },
    ],
  });

  config.module.rules.push({
    test: /\.mjs$/,
    include: /node_modules/,
    type: 'javascript/auto',
  });

  // Parse props data for .tsx files
  // This is notoriously slow, and is making Storybook unusable.  Disabling for now.
  // See: https://github.com/storybookjs/storybook/issues/7998
  //
  // config.module.rules.push({
  //   test: /\.tsx$/,
  //   // Exclude example files, as we don't display props info for them
  //   exclude: /\.examples.tsx$/,
  //   use: [
  //     // Parse TS comments to create Props tables in the UI
  //     require.resolve('react-docgen-typescript-loader'),
  //   ],
  // });

  // Enable SASS, but exclude CSS Modules in Storybook
  config.module.rules.push({
    test: /\.scss$/,
    exclude: /\.module.(s(a|c)ss)$/,
    use: [
      { loader: 'style-loader' },
      { loader: 'css-loader', options: { importLoaders: 2 } },
      {
        loader: 'postcss-loader',
        options: {
          path: path.resolve(KIBANA_ROOT, 'src/optimize/postcss.config.js'),
        },
      },
      {
        loader: 'sass-loader',
        options: {
          prependData(loaderContext) {
            return `@import ${stringifyRequest(
              loaderContext,
              path.resolve(KIBANA_ROOT, 'src/legacy/ui/public/styles/_globals_v7light.scss')
            )};\n`;
          },
          sassOptions: {
            includePaths: [path.resolve(KIBANA_ROOT, 'node_modules')],
          },
        },
      },
    ],
  });

  // Enable CSS Modules in Storybook
  config.module.rules.push({
    test: /\.module\.s(a|c)ss$/,
    loader: [
      'style-loader',
      {
        loader: 'css-loader',
        options: {
          importLoaders: 2,
          modules: {
            localIdentName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
      {
        loader: 'postcss-loader',
        options: {
          path: path.resolve(KIBANA_ROOT, 'src/optimize/postcss.config.js'),
        },
      },
      {
        loader: 'sass-loader',
      },
    ],
  });

  // Exclude large-dependency modules that need not be included in Storybook.
  config.module.rules.push({
    test: [
      path.resolve(__dirname, '../public/components/embeddable_flyout'),
      path.resolve(__dirname, '../../reporting/public'),
    ],
    use: 'null-loader',
  });

  // Ensure jQuery is global for Storybook, specifically for the runtime.
  config.plugins.push(
    new webpack.ProvidePlugin({
      $: 'jquery',
      jQuery: 'jquery',
    })
  );

  // Reference the built DLL file of static(ish) dependencies, which are removed
  // during kbn:bootstrap and rebuilt if missing.
  config.plugins.push(
    new webpack.DllReferencePlugin({
      manifest: path.resolve(DLL_OUTPUT, 'manifest.json'),
      context: KIBANA_ROOT,
    })
  );

  // Copy the DLL files to the Webpack build for use in the Storybook UI
  config.plugins.push(
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(DLL_OUTPUT, 'dll.js'),
          to: 'dll.js',
        },
        {
          from: path.resolve(DLL_OUTPUT, 'dll.css'),
          to: 'dll.css',
        },
      ],
    })
  );

  config.plugins.push(
    // replace imports for `uiExports/*` modules with a synthetic module
    // created by create_ui_exports_module.js
    new webpack.NormalModuleReplacementPlugin(/^uiExports\//, (resource) => {
      // uiExports used by Canvas
      const extensions = {
        hacks: [],
        chromeNavControls: [],
      };

      // everything following the first / in the request is
      // treated as a type of appExtension
      const type = resource.request.slice(resource.request.indexOf('/') + 1);

      resource.request = [
        // the "val-loader" is used to execute create_ui_exports_module
        // and use its return value as the source for the module in the
        // bundle. This allows us to bypass writing to the file system
        require.resolve('val-loader'),
        '!',
        require.resolve(KIBANA_ROOT + '/src/optimize/create_ui_exports_module'),
        '?',
        // this JSON is parsed by create_ui_exports_module and determines
        // what require() calls it will execute within the bundle
        JSON.stringify({ type, modules: extensions[type] || [] }),
      ].join('');
    }),

    // Mock out libs used by a few componets to avoid loading in kibana_legacy and platform
    new webpack.NormalModuleReplacementPlugin(
      /(lib)?\/notify/,
      path.resolve(__dirname, '../tasks/mocks/uiNotify')
    ),
    new webpack.NormalModuleReplacementPlugin(
      /lib\/download_workpad/,
      path.resolve(__dirname, '../tasks/mocks/downloadWorkpad')
    ),
    new webpack.NormalModuleReplacementPlugin(
      /(lib)?\/custom_element_service/,
      path.resolve(__dirname, '../tasks/mocks/customElementService')
    ),
    new webpack.NormalModuleReplacementPlugin(
      /(lib)?\/ui_metric/,
      path.resolve(__dirname, '../tasks/mocks/uiMetric')
    )
  );

  // Tell Webpack about relevant extensions
  config.resolve.extensions.push('.ts', '.tsx', '.scss');

  // Alias imports to either a mock or the proper module or directory.
  // NOTE: order is important here - `ui/notify` will override `ui/notify/foo` if it
  // is added first.
  config.resolve.alias['ui/notify/lib/format_msg'] = path.resolve(
    __dirname,
    '../tasks/mocks/uiNotifyFormatMsg'
  );
  config.resolve.alias['ui/notify'] = path.resolve(__dirname, '../tasks/mocks/uiNotify');
  config.resolve.alias['ui/url/absolute_to_parsed_url'] = path.resolve(
    __dirname,
    '../tasks/mocks/uiAbsoluteToParsedUrl'
  );
  config.resolve.alias['ui/chrome'] = path.resolve(__dirname, '../tasks/mocks/uiChrome');
  config.resolve.alias.ui = path.resolve(KIBANA_ROOT, 'src/legacy/ui/public');
  config.resolve.alias.ng_mock$ = path.resolve(KIBANA_ROOT, 'src/test_utils/public/ng_mock');

  config.resolve.extensions.push('.mjs');

  return config;
};
