// Convert raw audio to Transcribe real time streaming format

const eventStreamMarshaller = require('./eventStreamMarshaller');
const getAudioEventMessage = require('./getAudioeventMessage');

// export default function convertPayload(raw) {
module.exports =  function convertPayload(raw) {    
    if (raw == null)
        return;

    // Add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(raw);

    // Convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}
