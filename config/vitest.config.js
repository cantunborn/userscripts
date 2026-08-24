module.exports = {
  root: __dirname + '/..',
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    globals: true,
  },
};
