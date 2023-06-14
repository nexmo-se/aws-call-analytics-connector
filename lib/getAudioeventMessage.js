module.exports = function getAudioEventMessage(buffer) {    
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ':message-type': {
                type: 'string',
                value: 'event'
            },
            ':event-type': {
                type: 'string',
                value: 'AudioEvent'
            },
            ':content-type': {
                type: 'string',
                value: 'application/octet-stream'
            }
        },
        body: buffer
    };
}
