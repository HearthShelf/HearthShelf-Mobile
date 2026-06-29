// Enables tsconfig "paths" (@/* -> ./src/*) resolution in Metro.
// (app.json is still the source of truth for the rest of the config.)
const appJson = require('./app.json')

module.exports = {
  ...appJson.expo,
  experiments: {
    ...(appJson.expo.experiments || {}),
    tsconfigPaths: true,
  },
}
