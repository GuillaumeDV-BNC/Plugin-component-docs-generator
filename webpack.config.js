const path = require('path')
const webpack = require('webpack')
const fs = require('fs')

module.exports = (env, argv) => {
  const isProd = argv && argv.mode === 'production'
  return {
    mode: isProd ? 'production' : 'development',
    devtool: isProd ? false : 'inline-source-map',
    entry: { code: './code.ts' },
    module: {
      rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    output: {
      filename: '[name].js',
      path: path.resolve(__dirname),
    },
    plugins: [
      new webpack.DefinePlugin({
        __html__: JSON.stringify(
          fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8')
        ),
      }),
    ],
  }
}
