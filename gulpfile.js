'use strict';

const esbuild  = require('esbuild');
const gulp = require('gulp');
const jshint = require('gulp-jshint');
const stylish = require('jshint-stylish');
const filelog = require('gulp-filelog');
const parseArgs = require('minimist');
const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const PKG_INFO = require('./package.json');

// gulp-header.
const BANNER = fs.readFileSync('banner.txt').toString();
const BANNER_OPTS = {
    pkg: PKG_INFO,
    currentYear: (new Date()).getFullYear()
};

const compiledBanner = _.template(BANNER);
const bannerString = compiledBanner(BANNER_OPTS);

const env = parseArgs(process.argv.slice(2));

gulp.task('lint', function () {
    return gulp.src('lib/**/*.js')
        .pipe(filelog('lint'))
        .pipe(jshint('.jshintrc'))
        .pipe(jshint.reporter(stylish));
});


const polyfillPlugin = {
  name: 'node-polyfills',
  setup(build) {
    build.onResolve({ filter: /^events$/ }, () => ({
      path: require.resolve('events/'),
      namespace: 'file'
    }));

    build.onResolve({ filter: /^timers$/ }, () => ({
      path: require.resolve('timers-browserify'),
      namespace: 'file'
    }));
  }
};

gulp.task('build', async function () {
    const isProduction = env.type === 'production';
    const destFileName = isProduction ? `${PKG_INFO.name}.min.js` : `${PKG_INFO.name}.js`;

    await esbuild.build({
        entryPoints: [path.join(__dirname, PKG_INFO.main)],
        bundle: true,
        format: 'esm',
        globalName: PKG_INFO.name,
        sourcemap: true,
        minify: isProduction,
        outfile: path.join('dist', destFileName),
        banner: {
            js: bannerString
        },
        plugins: [polyfillPlugin]
    });
    await esbuild.build({
        entryPoints: ['lib/worker.js'],
        bundle: true,
        format: 'esm',       // keep esm for workers
        outfile: 'dist/worker.js',
        sourcemap: isProduction,
        minify: isProduction,
        banner: {
            js: bannerString
        },
        plugins: [polyfillPlugin]
    });

    return gulp.src(`dist/${destFileName}`)
        .pipe(filelog('build'))
});

gulp.task('watch', function() {
    gulp.watch(['lib/**/*.js'], gulp.series('lint', 'build'));
});


gulp.task('dist', gulp.series('lint', 'build'));
gulp.task('default', gulp.series('dist'));
