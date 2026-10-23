// Babel nur für Metro und Jest; Standard-Preset von Expo.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
