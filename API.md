
## API

The entrypoint to the library is the `sylkrtc` object. Several objects (`Connection`, `Account` and `Call`) inherit from Node's `EventEmitter` class, you may want to check [its documentation](https://nodejs.org/api/events.html).


### sylkrtc

The main entrypoint to the library. It exposes the main function to connect to SylkServer and some utility functions for general use.


#### sylkrtc.createConnection(options={})

Creates a `sylkrtc` connection towards a SylkServer instance. The only supported option (at the moment) is "server", which should point to the WebSocket endpoint of the WebRTC gateway application. Example: `wss://1.2.3.4:8088/webrtcgateway/ws`.

It returns a `Connection` object.

Example:

    let connection = sylkrtc.createConnection({server: 'wss://1.2.3.4:8088/webrtcgateway/ws'});


#### sylkrtc.closeMediaStream(stream)

Helper function to close the given `stream`. When a local media stream is closed the camera is stopped in case it was
active, for example.

Note: when a `Call` is terminated all streams will be automatically closed.


### Connection

Object representing the interaction with SylkServer. Multiple connections can be created with
`sylkrtc.createConnection`, but typically only one is needed. Reconnecting in case the connection is interrupted is
taken care of automatically.

Events emitted:
* **stateChanged**: indicates the WebSocket connection state has changed. Two arguments are provided: `oldState` and
  `newState`, the old connection state and the new connection state, respectively. Possible state values are: null,
  connecting, connected, ready, disconnected and closed. If the connection is involuntarily interrupted the state will
  transition to disconnected and the connection will be retried. Once the closed state is set, as a result of the user
  calling Connection.close(), the connection can no longer be used or reconnected.


#### Connection.addAccount(options={}, cb=null)

Configures an `Account` to be used through `sylkrtc`.  2 options are required: *account* (the account ID) and
*password*. An optional *displayName* can be set. The account won't be registered, it will just be created.
Optionally *realm* can be passed, which will be used instead of the domain for the HA1 calculation.

The *password* won't be stored or transmitted as given, the HA1 hash (as used in
[Digest access authentication](https://en.wikipedia.org/wiki/Digest_access_authentication)) is created and used instead.

The `cb` argument is a callback which will be called with an error and the account object
itself.

Example:

    connection.addAccount({account: saghul@sip2sip.info, password: 1234}, function(error, account) {
        if (error) {
            console.log('Error adding account!' + account);
        } else {
            console.log('Account added!');
        }
    });


#### Connection.removeAccount(account, cb=null)

Removes the given account. The callback will be called once the operation completes (it
cannot fail).

Example:

    connection.removeAccount(account, function() {
        console('Account removed!');
    });


#### Connection.reconnect()

Starts reconnecting immediately if the state was 'disconnected';


#### Connection.close()

Close the connection with SylkServer. All accounts will be unbound.


#### Connection.state

Getter property returning the current connection state.


### Account

Object representing a SIP account which will be used for making / receiving calls.

Events emitted:
* **registrationStateChanged**: indicates the SIP registration state has changed. Three arguments are provided:
  `oldState`, `newState` and `data`. `oldState` and `newState` represent the old registration state and the new
  registration state, respectively, and `data` is a generic per-state data object. Possible states:
   * null: registration hasn't started or it has ended
   * registering: registration is in progress
   * registered
   * failed: registration failed, the `data` object will contain a 'reason' property.
* **outgoingCall**: emitted when an outgoing call is made. A single argument is provided: the `Call` object.
* **incomingCall**: emitted when an incoming call is received. Two arguments are provided: the `Call` object and a
  `mediaTypes` object, which has 2 boolean properties: `audio` and `video`, indicating if those media types were
  present in the initial SDP.
* **missedCall**: emitted when an incoming call is missed. A `data` object is provided, which contains an `originator`
  attribute, which is an `Identity` object.
* **conferenceInvite**: emitted when someone invites us to join a conference. A `data` object is provided, which contains
  an `originator` attribute indicating who invited us, and a `room` attribute indicating what conference we have been invited to.


#### Account.register()

Start the SIP registration process for the account. Progress will be reported via the
*registrationStateChanged* event.

Note: it's not necessary to be registered to make an outgoing call.


#### Account.unregister()

Unregister the account. Progress will be reported via the
*registrationStateChanged* event.


#### Account.call(uri, options={})

Start an outgoing call. Supported options:
* pcConfig: configuration options for `RTCPeerConnection`. [Reference](http://w3c.github.io/webrtc-pc/#configuration).
* offerOptions: `RTCOfferOptions`. [Reference](http://w3c.github.io/webrtc-pc/#idl-def-RTCOfferOptions).
* localStream: user provided local media stream (acquired with `getUserMedia` TODO).

Example:

    const call = account.call('3333@sip2sip.info', {localStream: stream});


#### Account.joinConference(uri, options={})

Join (or create in case it doesn't exist) a multi-party video conference at the given URI. Supported options:

* pcConfig: configuration options for `RTCPeerConnection`. [Reference](http://w3c.github.io/webrtc-pc/#configuration).
* offerOptions: `RTCOfferOptions`. [Reference](http://w3c.github.io/webrtc-pc/#idl-def-RTCOfferOptions).
* localStream: user provided local media stream (acquired with `getUserMedia` TODO).

Example:

    const conf = account.joinConference('test123@conference.sip2sip.info', {localStream: stream});


#### Account.id

Getter property returning the account ID.


#### Account.displayName

Getter property returning the account display name.


#### Account.password

Getter property returning the HA1 password for the account.


#### Account.registrationState

getter property returning the current registration state.


### Call

Object representing a audio/video call. Signalling is done using SIP underneath.

Events emitted:
* **localStreamAdded**: emitted when the local stream is added to the call. A single argument is provided: the stream itself.
* **streamAdded**: emitted when a remote stream is added to the call. A single argument is provided: the stream itself.
* **stateChanged**: indicates the call state has changed. Three arguments are provided: `oldState`, `newState` and
  `data`. `oldState` and `newState` indicate the previous and current state respectively, and `data` is a generic
  per-state data object. Possible states:
    * terminated: the call has ended (the `data` object contains a `reason` attribute)
    * accepted: the call has been accepted (either locally or remotely)
    * incoming: initial state for incoming calls
    * progress: initial state for outgoing calls
    * established: call media has been established
* **dtmfToneSent**: emitted when one of the tones passed to `sendDtmf` is actually sent. An empty tone indicates all tones have
  finished playing.


#### Call.answer(options={})

Answer an incoming call. Supported options:
* pcConfig: configuration options for `RTCPeerConnection`. [Reference](http://w3c.github.io/webrtc-pc/#configuration).
* answerOptions: `RTCAnswerOptions`. [Reference](http://w3c.github.io/webrtc-pc/#idl-def-RTCAnswerOptions).
* localStream: user provided local media stream (acquired with `getUserMedia` TODO).


#### Call.terminate()

End the call.


#### Call.getLocalStreams()

Returns an array of *local* `RTCMediaStream` objects.


#### Call.getRemoteStreams()

Returns an array of *remote* `RTCMediaStream` objects.


#### Call.sendDtmf(tones, duration=100, interToneGap=70)

Sends the given DTMF tones over the active audio stream track.

**Note**: This feature requires browser support for `RTCPeerConnection.createDTMFSender`.


#### Call.account

Getter property which returns the `Account` object associated with this call.


#### Call.id

Getter property which returns the ID for this call. Note: this is not related to the SIP Call-ID header.


#### Call.direction

Getter property which returns the call direction: "incoming" or "outgoing". Note: this is not related to the SDP
"a=" direction attribute.


#### Call.state

Getter property which returns the call state.


#### Call.localIdentity

Getter property which returns the local identity. (See the `Identity` object).


#### Call.remoteIdentity

Getter property which returns the remote identity. (See the `Identity` object).


### Conference

Object representing a multi-party audio/video conference.

Events emitted:

* **localStreamAdded**: emitted when the local stream is added to the call. A single argument is provided: the stream itself.
* **stateChanged**: indicates the conference state has changed. Three arguments are provided: `oldState`, `newState` and
  `data`. `oldState` and `newState` indicate the previous and current state respectively, and `data` is a generic
  per-state data object. Possible states:
    * terminated: the conference has ended
    * accepted: the initial offer has been accepted
    * progress: initial state
    * established: conference has been established and media is flowing
* **participantJoined**: emitted when a participant joined the conference. A single argument is provided: an instance of
  `Participant`. Note that this event is only emitted when new participants join, `Conference.participants` should be checked
  upon the initial join to check what participants are already in the conference.
* **participantLeft**: emitted when a participant leaves the conference. A single argument is provided: an instance of
  `Participant`.

#### Conference.getLocalStreams()

Returns an array of *local* `RTCMediaStream` objects. These are the streams being published to the conference.


#### Conference.getRemoteStreams()

Returns an array of *remote* `RTCMediaStream` objects. These are the streams published by all other participants in the conference.


#### Conference.participants

Getter property which returns an array of `Participant` objects in the conference.


#### Conference.account

Getter property which returns the `Account` object associated with this conference.


#### Conference.id

Getter property which returns the ID for this conference. Note: this is not related to the URI.


#### Conference.direction

Dummy property always returning "outgoing", in order to provide the same API as `Call`.


#### Conference.state

Getter property which returns the conference state.


#### Conference.localIdentity

Getter property which returns the local identity. (See the `Identity` object). This will always be built from the account.


#### Conference.remoteIdentity

Getter property which returns the remote identity. (See the `Identity` object). This will always be built from the remote URI.


### Participant

Object representing another user connected to the same conference.

Events emitted:

* **streamAdded**: emitted when a remote stream is added. A single argument is provided: the stream itself.
* **stateChanged**: indicates the participant state has changed. Three arguments are provided: `oldState`, `newState` and
  `data`. `oldState` and `newState` indicate the previous and current state respectively, and `data` is a generic
  per-state data object. Possible states:
    * null: initial state
    * progress: the participant is being attached to, this will happen as a result to `Participant.attach`
    * established: media is flowing from this participant


#### Participant.id

    Getter property which returns the ID for this participant. Note this an abstract ID.


#### Participant.state

    Getter property which returns the participant state.


#### Participant.identity

    Getter property which returns the participant's identity. (See the `Identity` object).


#### Participant.streams

    Getter property which returns the audio / video streams for this participant.


#### Participant.attach()

    Start receiving audio / video from this participant. Once attached the participant's state will switch to 'established'
    and its audio /video stream(s) will be available in `Participant.streams`. If a participant is not attached to, no
    audio or video will be received from them.


#### Participant.detach()

    Stop receiving audio / video from this participant. The opposite of `Participant.attach()`.


### Identity

Object representing the identity of the caller / callee.


#### Identity.uri

SIP URI, without the 'sip:' prefix.


#### Identity.displayName

Display name assiciated with the identity. Set to '' if absent.


#### Identity.toString()

Function returning a string representation of the identity. It can take 2 forms
depending on the availability of the display name: 'bob@biloxi.com' or
'Bob <bob@biloxi.com>'.
