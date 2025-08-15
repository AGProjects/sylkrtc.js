
# sylkrtc.js

JavaScript library implementing the API for communicating with [SylkServer's](http://sylkserver.com)
WebRTC gateway application.

This client library can be used for creating Web applications with the following features:

* Audio and video sessions
* Screen sharing
* Multi-party conferencing
* File sharing in conferences
* Chat in conferences
* SIP interoperability


## Building

Grab the source code using Darcs or Git and install the dependencies:

    cd sylkrtc
    ./configure


Build the development release (not minified):

    make


Build a minified version:

    make min

The build file `worker.js` needs to be placed in the same location as the `sylkrtc(.min).js` script.

## Development

Auto-building the library as changes are made:

    make watch


### Debugging

sylkrtc uses the [debug](https://github.com/visionmedia/debug) library for easy debugging. By default debugging is disabled. In order to enable sylkrtc debug enable it like so:

    debug.enable('sylkrtc*');


## API

See [API.md](API.md).


## License

MIT. See the `LICENSE` file in this directory.


## Credits

Special thanks to [NLnet](http://nlnet.nl) and [SIDN fonds](https://www.sidnfonds.nl) for sponsoring most of the efforts behind this project.
