
## API

The entrypoint to the library is the `sylkrtc` object. Several objects (`Connection`, `Account` and `Call`) inherit from Node's `EventEmitter` class, you may want to check [its documentation](https://nodejs.org/api/events.html).


### sylkrtc

The main entrypoint to the library. It exposes the main function to connect to SylkServer and some utility functions for general use.


#### sylkrtc.createConnection(options={})

Creates a `sylkrtc` connection towards a SylkServer instance. The supported options are "server" and optional object "userAgent". Where server should point to the WebSocket endpoint of the WebRTC gateway application. Example: `wss://1.2.3.4:8088/webrtcgateway/ws`.

It returns a `Connection` object.

Example:

    let connection = sylkrtc.createConnection({server: 'wss://1.2.3.4:8088/webrtcgateway/ws'});

If the optional userAgent object is given, it should contain:
* `name` : string with the name of the application.
* `version`: version string of the application.

Example with userAgent:

    let connection = sylkrtc.createConnection({server: 'wss://1.2.3.4:8088/webrtcgateway/ws', userAgent: {name: 'Some Apllication', version: '0.99.9'}});


#### sylkrtc.utils

Helper module with utility functions.

* `attachMediaStream`: function to easily attach a media stream to an element. It reexports [attachmediastream](https://github.com/otalk/attachMediaStream).
* `closeMediaStream`: function to close the given media stream.
* `sanatizeHtml`: function to XSS sanitize html strings

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
cannot fail). The callback will be called with an error object.

Example:

    connection.removeAccount(account, function(error) {
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
* **message**: emitted when a message is received. A single argument is provided: the `Message` object.
* **messageStateChanged**: emitted when a message state has changed. A single argument is provided, an object which contains:
    * `messageId`
    * `state`

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
* audio: optional boolean parameter to tell the server it should support audio. Note: this is only used if you are creating
  the conference.
* video: optional boolean parameter to tell the server it should support video. Note: this is only used if you are creating
  the conference.

Example:

    const conf = account.joinConference('test123@conference.sip2sip.info', {localStream: stream});


#### Account.id

Getter property returning the account ID.


#### Account.displayName

Getter property returning the account display name.


#### Account.password

Getter property returning the HA1 password for the account.


#### Account.registrationState

Getter property returning the current registration state.


#### Account.messages *WIP*

Getter property returning the messages.


#### Account.setDeviceToken(token, platform, device, silent, app)

Set the current device token for this account. The device token is an opaque string usually provided by the Firebase SDK
which SylkServer will inject with the other parameters as parameters into to contact header when a SIP account is registered.
The parameter `silent` must be a boolean and all other parameters should be strings.


#### Account.sendMessage(uri, message, contentType) *WIP*

Send a (SIP) message to uri. The message will be send with IMDN enabled. `message` should contain a string, `type` should contain the message content type like
'text/plain', 'text/html', 'image/png'. The function returns an instance of `Message`.


#### Account.sendDispositionNotification(uri, id, timestamp, state) *WIP*

Send a disposition notification to uri. `id` should contain the original
message id, `timestamp` should contain the original timestamp, `state` should
contain the IMDN state you want to send. `delivered` will be sent automatically if
the received messages requested `positive-delivery` disposition.


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
    * early-media: the call has an session description before it is accepted
    * established: call media has been established, in case of early media this happens before accepted
* **dtmfToneSent**: emitted when one of the tones passed to `sendDtmf` is actually sent. An empty tone indicates all tones have
  finished playing.


#### Call.answer(options={})

Answer an incoming call. Supported options:
* pcConfig: configuration options for `RTCPeerConnection`. [Reference](http://w3c.github.io/webrtc-pc/#configuration).
* answerOptions: `RTCAnswerOptions`. [Reference](http://w3c.github.io/webrtc-pc/#idl-def-RTCAnswerOptions).
* localStream: user provided local media stream (acquired with `getUserMedia` TODO).


#### Call.startScreensharing(newTrack)

Start sharing a screen/window. `newTrack` should be a `RTCMediaStreamTrack` containing the screen/window. Internally it will call
replace track with the keep flag enabled and it will set the state so it can be tracked.


#### Call.stopScreensharing()

Stop sharing a screen/window and restore the previousTrack.


#### Call.replaceTrack(oldTrack, newTrack, keep=false, cb=null)

Replace a local track inside a call. If the keep flag is set, it will store the replaced track internally so it
can be used later. The callback will be called  with a true value once the operation completes.


#### Call.terminate()

End the call.


#### Call.getLocalStreams()

Returns an array of *local* `RTCMediaStream` objects.


#### Call.getRemoteStreams()

Returns an array of *remote* `RTCMediaStream` objects.


#### Call.getSenders()

Returns an array of `RTCRtpSender` objects.


#### Call.getReceivers()

Returns an array of `RTCRtpReceiver` objects.


#### Call.sendDtmf(tones, duration=100, interToneGap=70)

Sends the given DTMF tones over the active audio stream track.

**Note**: This feature requires browser support for `RTCPeerConnection.createDTMFSender`.


#### Call.account

Getter property which returns the `Account` object associated with this call.


#### Call.id

Getter property which returns the ID for this call. Note: this is not related to the SIP Call-ID header.


#### Call.callId

Getter property which returns the call-id for this call. Note: this **is** the SIP Call-ID.


#### Call.sharingScreen

Getter property which returns the screen sharing state.


#### Call.direction

Getter property which returns the call direction: "incoming" or "outgoing". Note: this is not related to the SDP
"a=" direction attribute.


#### Call.state

Getter property which returns the call state.


#### Call.localIdentity

Getter property which returns the local identity. (See the `Identity` object).


#### Call.remoteIdentity

Getter property which returns the remote identity. (See the `Identity` object).


#### Call.remoteMediaDirections

Getter property which returns an object with the directions of the remote streams. Note: this **is** related to the SDP "a=" direction attribute.


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
* **roomConfigured**: emitted when the room is configured by the server. A single argument is provided: an object with the
  `originator` of the message which is an `Identity` or string and a list of `activeParticipants`. The list contains
  instances of `Participant`.
* **fileSharing**: emitted when a participant in the room shares files. A single argument is provided: a list of instances of `SharedFile`.
* **message**: emitted when a message is received. A single argument is provided, an instance of `Message`.
* **sendingMessage**: emitted when a message will be sent. A single argument is provided, an instance of `Message`.
* **composingIndication**: emitted when somebody in the room is typing. A single argument is provided, an object with `refresh`, `sender`
  and `state`. The `sender` is an `Identity`.
* **muteAudio**: emitted when a `Participant` requests to `muteAudioParticipants`.
* **raisedHands**: emitted when a `Participant` raises or lower his hand. A single argument is provided: a list of `raisedHands`.
  The list contains instances of `Participant`.

#### Conference.startScreensharing(newTrack)

Start sharing a screen/window. `newTrack` should be a `RTCMediaStreamTrack` containing the screen/window. Internally it will call
replace track with the keep flag enabled and it will set the state so it can be tracked.


#### Conference.stopScreensharing()

Stop sharing a screen/window and restore the previousTrack.


#### Conference.sendMessage(message, type)

Send a chat message to the conference. `message` should contain a string, `type` should contain the message content type like
'text/plain', 'text/html', 'image/png'. The function returns an instance of `Message`.


#### Conference.sendComposing(state)

Send a composing indication to the conference. `state` should be either `active` or `idle`.


#### Conference.replaceTrack(oldTrack, newTrack, keep=false, cb=null)

Replace a local track inside the conference. If the keep flag is set, it will store the replaced track internally so it
can be used later. The callback will be called  with a true value once the operation completes.


#### Conference.getLocalStreams()

Returns an array of *local* `RTCMediaStream` objects. These are the streams being published to the conference.


#### Conference.getRemoteStreams()

Returns an array of *remote* `RTCMediaStream` objects. These are the streams published by all other participants in the conference.


#### Conference.getSenders()

Returns an array of `RTCRtpSender` objects. The sender objects get the *local* tracks being published to the conference.


#### Conference.getReceivers()

Returns an array of `RTCRtpReceiver` objects. The receiver objects get the *remote* tracks published by all other
participants in the conference.


#### Conference.scaleLocalTrack(track, divider)

Scale the given local video track by a given divider. Currently this function will not work, since browser support is lacking.


#### Conference.configureRoom(participants, cb=null)

Configure the room. `Participants` is a list with the publisher session ids of the new active participants. The active participants
will get more bandwidth and the other participants will get a limited bandwidth. On success the *roomConfigured* event is emitted.

The `cb` argument is a callback which will be called on an error with error as argument.


#### Conference.muteAudioParticipants()

Request muting for all participants. All participants in the room will get a `muteAudio` event from the server.


#### Conference.toggleHand(participantSession)

Raise/Lower your hand. An optional participant session can be provided, so the hand of this specific session is raised/lowered.
Calling this function will trigger a `raisedHands` event to all participants in the room.


#### Conference.participants

Getter property which returns an array of `Participant` objects in the conference.


#### Conference.activeParticipants

Getter property for the Active Participants which returns an array of `Participant` objects in the conference.


#### Conference.sharedFiles

Getter property for the Shared Files which returns an array of `SharedFile` objects in the conference.


#### Conference.messages

Getter property for the Messages which returns an array of `Message` objects in the conference.


#### Conference.raisedHands

Getter property for the Raised Hands which returns an array of `Participant` objects.


#### Conference.account

Getter property which returns the `Account` object associated with this conference.


#### Conference.id

Getter property which returns the ID for this conference. Note: this is not related to the URI.


#### Conference.sharingScreen

Getter property which returns the screen sharing state.


#### Conference.direction

Dummy property always returning "outgoing", in order to provide the same API as `Call`.


#### Conference.state

Getter property which returns the conference state.


#### Conference.localIdentity

Getter property which returns the local identity. (See the `Identity` object). This will always be built from the account.


#### Conference.remoteIdentity

Getter property which returns the remote identity. (See the `Identity` object). This will always be built from the remote URI.


#### Conference.supportsAudio

Getter property which returns if audio relaying/offer is supported by the server.


#### Conference.supportsVideo

Getter property which returns if video relaying/offer is supported by the server.


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


#### Participant.publisherId

Getter property which returns the participant's publisher session id.


#### Participant.streams

Getter property which returns the audio / video streams for this participant.


#### Participant.videoPaused

Getter property which returns true / false when the video subscription is paused / not paused


#### Participant.getReceivers()

Returns an array of `RTCRtpReceiver` objects. The receiver objects get the *remote* tracks published by the
participant.


#### Participant.attach()

Start receiving audio / video from this participant. Once attached the participant's state will switch to 'established'
and its audio /video stream(s) will be available in `Participant.streams`. If a participant is not attached to, no
audio or video will be received from them.


#### Participant.detach(isRemoved=false)

Stop receiving audio / video from this participant. The opposite of `Participant.attach()`. The isRemoved
option needs to be true used when the participant has already left. This is the case when you receive the
'participantLeft' event.


#### Participant.pauseVideo()

Stop receiving video from this participant. The opposite of `Participant.resumeVideo()`.


#### Participant.resumeVideo()

Resume receiving video from this participant. The opposite of `Participant.pauseVideo()`.


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


### SharedFile

Object representing a shared file.


#### SharedFile.filename

The filename of the shared file


#### SharedFile.filesize

The filesize in bytes of the shared file


#### SharedFile.uploader

The `Identity` of the uploader.


#### SharedFile.session

The session UUID which was used to upload the file


### Message

Object representing a message.

Events emitted:
* **stateChanged**: indicates the message state has changed. Two arguments are provided: `oldState`, `newState`.
  `oldState` and `newState` indicate the previous and current state respectively. Possible states:
    * received: the message was received
    * pending: the message is pending delivery
    * delivered: the message has been delivered, for direct messages it means an IMDN `delivered` was received
    * accepted: only valid in direct messages, the message was accepted for delivery
    * displayed: only valid in direct messages, the message was displayed, an IMDN `display` was received
    * failed: something went wrong, either it is not delivered, or it could not be sent


#### Message.id

Getter property for id the message


#### Message.content

Getter property for the content of the message. In case content type of the message is 'text/html', it will be sanatized.


#### Message.contentType

Getter property for the content type of the message.


#### Message.sender

Getter property for the `Identity` of the message sender.


#### Message.receiver

Getter property for the uri of the message receiver.


#### Message.timestamp

Getter property for the `Date` object of the message.


#### Message.type

Getter property for the type of the message, it can be `normal` or `status`.


#### Message.state

Getter property for the state of the message. It can be `received`, `pending`, `delivered`, `failed`, `accepted`, `displayed`.

