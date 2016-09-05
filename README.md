
# sylkrtc.js

JavaScript library implementing the API for communicating with [SylkServer's](http://sylkserver.com)
WebRTC gateway application.

This client library can be used for creating Web applications with the following features:

* Audio / Video calls
* Interoperability with SIP endpoints
* Multi-party video conferencing


## Building

Grab the source code using Darcs or Git and install the dependencies:

    cd sylkrtc
    ./configure


Build the development release (not minified):

    make


Build a minified version:

    make min


## Development

Auto-building the library as changes are made:

    make watch


### Debugging

sylkrtc uses the [debug](https://github.com/visionmedia/debug) library for easy debugging. By default debugging is disabled. In order to enable sylkrtc debug type the following in the browser JavaScript console:

    sylkrtc.debug.enable('sylkrtc*');

Then refresh the page.


## API

See [API.md](API.md).


## License

MIT. See the `LICENSE` file in this directory.


## Credits

Special thanks to [NLnet](http://nlnet.nl) and [SIDN fonds](https://www.sidnfonds.nl) for sponsoring most of the efforts behind this project.

