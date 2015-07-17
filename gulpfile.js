'use strict';

var babelify = require('babelify');
var browserify = require('browserify');
var source = require('vinyl-source-stream');
var buffer = require('vinyl-buffer');
var gulp = require('gulp');
var jshint = require('gulp-jshint');
var stylish = require('jshint-stylish');
var uglify = require('gulp-uglify');
var gutil = require('gulp-util');
var filelog = require('gulp-filelog');
var header = require('gulp-header');
var sourcemaps = require('gulp-sourcemaps');

var fs = require('fs');
var path = require('path');

var PKG_INFO = require('./package.json');

// gulp-header.
var BANNER = fs.readFileSync('banner.txt').toString();
var BANNER_OPTS = {
    pkg: PKG_INFO,
    currentYear: (new Date()).getFullYear()
};


gulp.task('lint', function () {
    return gulp.src('lib/**/*.js')
        .pipe(filelog('lint'))
        .pipe(jshint('.jshintrc'))
        .pipe(jshint.reporter(stylish));
});


gulp.task('build', function () {
    var dest;
    var isProduction = (gutil.env.type === 'production');
    if (isProduction) {
        dest = PKG_INFO.name + '.min.js';
    } else {
        dest = PKG_INFO.name + '.js';
    }
    return browserify([path.join(__dirname, PKG_INFO.main)],
                      {standalone: PKG_INFO.name,
                       debug: true})
        .transform(babelify)
        .bundle()
        .pipe(source(dest))
        .pipe(buffer())
        .pipe(sourcemaps.init({loadMaps: true}))
        .pipe(filelog('build'))
        .pipe(isProduction ? uglify({mangle: false}) : gutil.noop())
        .pipe(header(BANNER, BANNER_OPTS))
        .pipe(sourcemaps.write('.'))
        .pipe(gulp.dest('dist/'));
});


gulp.task('watch', function() {
    gulp.watch(['lib/**/*.js'], gulp.series('lint', 'build'));
});


gulp.task('dist', gulp.series('lint', 'build'));
gulp.task('default', gulp.series('dist'));
