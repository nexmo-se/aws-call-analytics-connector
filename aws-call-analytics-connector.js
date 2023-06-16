'use strict'

//-------------

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const expressWs = require('express-ws')(app);
const { Readable } = require('stream');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

const WebSocketClient = require('websocket').client;

// -- HTTP client --

const webHookRequest = require('request');

const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
};

//--------------------

app.use(bodyParser.json());

//-------

let router = express.Router();
router.get('/', express.static('app'));
app.use('/app',router);

//-----

const awsRegion = process.env.AWS_REGION;

if (!awsRegion) {
  console.log('No AWS region specified!');
  process.exit(); // Exit program, cannot proceed
};

//---- Amazon Trancribe (AWS ASR engine)

const mediaEncoding= 'pcm'; 
const samplingRate = '16000';

const v4 = require('aws-signature-v4');

// process.env.AWS_ACCESS_KEY_ID -- picked up by createPresignedURL 
// process.env.AWS_SECRET_ACCESS_KEY -- picked up by createPresignedURL

const awsHost = 'transcribestreaming.' + awsRegion + '.amazonaws.com:8443';


//--- see https://docs.aws.amazon.com/transcribe/latest/dg/websocket-med.html (medical transcription)
// const awsPath = '/medical-stream-transcription-websocket';

//--- see https://docs.aws.amazon.com/transcribe/latest/dg/channel-id.html (regular transcription - 2-channel)
const awsPath = '/stream-transcription-websocket';
// const awsPath = '/medical-stream-transcription-websocket';

const awsService = 'transcribe';

// possible values at this time: PRIMARYCARE, CARDIOLOGY, NEUROLOGY, ONCOLOGY, RADIOLOGY, or UROLOGY
// info passed by peer VAPI websocket
let specialty = 'PRIMARYCARE';

//-- Amazon Transcribe Medical
// possible value: DICTATION, CONVERSATION
// should be always DICTATION even for 1-to-1, or even multiparty
// possible exception: multiple speakers speaking on same device, i.e. on same call leg
const type = 'DICTATION';

//-----------

const hexSilencePayload = "f8ff".repeat(320);
// console.log('hexSilencePayload:', hexSilencePayload);

const silenceMsg = Buffer.from(hexSilencePayload, "hex"); // 640-byte payload for silence - 16 bits - 16 kHz - PCM
// console.log('silenceMsg:', silenceMsg);

const waitTime = 30; // in ms, wait that time for the other queue to get a message

const maxQueueSize = 5;

//-----------

const convertPayload = require('./lib/convertPayload');
const eventStreamMarshaller = require('./lib/eventStreamMarshaller');

//-----

// const { ComprehendClient, DetectSentimentCommand } = require("@aws-sdk/client-comprehend"); 
// const comprehendClient = new ComprehendClient({ region: awsRegion });


//==========================================================

function reqCallback(error, response, body) {
    if (body != "Ok") {  
      console.log("Webhook call status to VAPI application:", body);
    };  
}

//-------------------

async function sendPayloadToAws(channel, originalUuid, msg)  {

  // console.log("\nchannel:", channel);
  // console.log("originalUuid:", originalUuid);
  // console.log("msg:", msg);

  if (app.locals[`clientConnection_${originalUuid}`]) {
    // console.log('sending binary payload to AWS')

    // received actual binary payload is "message.binaryData"

    // console.log(`queue_${originalUuid}_${channel}`, "push", msg);

    app.locals[`queue_${originalUuid}_${channel}`].push(msg);
    
    // app.locals[`last_msg_${originalUuid}_${channel}`] = msg;
    app.locals[`last_msg_${originalUuid}_${channel}`] = Buffer.from(msg);

    // console.log("app.locals[`last_msg_${originalUuid}_${channel}`]:", app.locals[`last_msg_${originalUuid}_${channel}`]);

    // limit size of queue # 0 in case it overruns - which should never happen
    app.locals[`queue_${originalUuid}_0`].length = Math.min(app.locals[`queue_${originalUuid}_0`].length, maxQueueSize);

    if (channel === 0) {

      setTimeout(() => {

        if (app.locals[`queue_${originalUuid}_0`].length != 0) { // check queue # 0

          let mixPayload = Buffer.alloc(0);

          // app.locals[`msg_${originalUuid}_0`] = app.locals[`queue_${originalUuid}_0`].shift();  // dequeue from queue # 0

          app.locals[`msg_${originalUuid}_0`] = Buffer.from(app.locals[`queue_${originalUuid}_0`].shift());  // dequeue from queue # 0

          if (app.locals[`queue_${originalUuid}_1`].length != 0) { // check queue # 1
            
            // console.log(`Queue ${1 - channel} is not empty`);

            // app.locals[`msg_${originalUuid}_1`] = app.locals[`queue_${originalUuid}_1`].shift();
            // app.locals[`msg_${originalUuid}_1`] = Buffer.from(app.locals[`queue_${originalUuid}_1`].shift(), "binary");
            app.locals[`msg_${originalUuid}_1`] = Buffer.from(app.locals[`queue_${originalUuid}_1`].shift());

            // app.locals[`last_msg_${originalUuid}_1`] = app.locals[`msg_${originalUuid}_1`];
            app.locals[`last_msg_${originalUuid}_1`] = Buffer.from(app.locals[`msg_${originalUuid}_1`]);

            app.locals[`queue_${originalUuid}_1`].length = Math.min(app.locals[`queue_${originalUuid}_1`].length, maxQueueSize); // limit size of queue # 1 in case it overruns

          } else {
            
            // console.log(`Queue 1 is empty`)

            // console.log("Payload on channel 0:",   app.locals[`msg_${originalUuid}_0`] );

            if (app.locals[`last_msg_${originalUuid}_1`] == null) {

              app.locals[`msg_${originalUuid}_1`]  = silenceMsg;  // silenceMsg is already a buffer
              // app.locals[`msg_${originalUuid}_1`]  = Buffer.from(silenceMsg);

            } else {

              app.locals[`msg_${originalUuid}_1`]  = app.locals[`last_msg_${originalUuid}_1`];  // already a buffer
              // app.locals[`msg_${originalUuid}_1`]  = Buffer.from(app.locals[`last_msg_${originalUuid}_1`]); 

            }

            // console.log("Payload on channel 1:",   app.locals[`msg_${originalUuid}_1`] );

          } 

          //>>>>>>>>>>>>>>>
          console.log("\n\nSubmit both channels audio payload to Amazon Transcribe"); 
          console.log("\nPayload on channel 0:", app.locals[`msg_${originalUuid}_0`] );
          console.log("\nPayload on channel 1:", app.locals[`msg_${originalUuid}_1`] );

          for (let i = 0; i < 160; i++) {
          // for(let i = 0; i < 2; i++) {

            // console.log("4 bytes from app.locals[`msg_${originalUuid}_0`]:");
            // console.log( Buffer.from(app.locals[`msg_${originalUuid}_0`].subarray(i*4, (i*4)+4)) );
            mixPayload = Buffer.concat([mixPayload, Buffer.from(app.locals[`msg_${originalUuid}_0`].subarray(i*4, (i*4)+4))]);

            // console.log("4 bytes from app.locals[`msg_${originalUuid}_1`]:");
            // console.log( Buffer.from(app.locals[`msg_${originalUuid}_1`].subarray(i*4, (i*4)+4)) );
            mixPayload = Buffer.concat([mixPayload, Buffer.from(app.locals[`msg_${originalUuid}_1`].subarray(i*4, (i*4)+4))]);

          }

          //>>>>>>>>>>>>>>>
          console.log('\nmixPayload:', mixPayload);

          const transcribePayload = convertPayload(mixPayload);

          // // console.log(Date.now());
          // console.log("sending to AWS transcribePayload:", transcribePayload);

          app.locals[`clientConnection_${originalUuid}`].send(Buffer.from(transcribePayload));
        }  

      }, waitTime);  

    }  
  
  } else {

    console.log('Amazon Transcribe WebSocket client linked to Vonage call uuid ' + originalUuid + ' not connected');

  };

}

//-------------- First call leg --------------
//-- Customer call leg for this instance -----

app.ws('/socket0', async (ws, req) => {

  const originalUuid = req.query.original_uuid; 
  const peerUuid = req.query.peer_uuid;
  // let callerNumber; // value set in  ws.on('message' ... section

  //-- Next 2 parameters apply to Amazon Transcribe Medical

  // possible values at this time: PRIMARYCARE, CARDIOLOGY, NEUROLOGY, ONCOLOGY, RADIOLOGY, or UROLOGY
  // const specialty = req.query.specialty;
  const specialty = "PRIMARYCARE";

  // possible value: DICTATION, CONVERSATION
  // const type = req.query.type;
  const type = "DICTATION";

  //----

  console.log('>>> websocket connected with');
  console.log('original call uuid:', originalUuid);
  console.log('peer uuid:', peerUuid);

  const webhookUrl = req.query.webhook_url;

  console.log('>>> webhookUrl:', webhookUrl);

  //-- if set by client application
  // const userName = req.query.user_name;
  
  //-- if set by client application
  // const userId = req.query.user_id;

  //-- if set by client application
  // const confName = req.query.conference_name;

  //-- if client application set custom query parameters, those values will be returned on reply webhooks to client application
  let xCustomFields = [];
  let customQueryParams = '';

  for (const queryParameter in req.query){    
    if (`${queryParameter}`.substring(0, 2) == 'x_') {
      xCustomFields.push(`"${queryParameter}": "${req.query[`${queryParameter}`]}"`);
    }
  };

  customQueryParams = "{" + xCustomFields.join(", ") + "}";
  console.log('>>> websocket custom query parameters:', customQueryParams);


  //-- for Amazon Transcribe or Amazon Transcribe Medical --------------------

  let transcribeException = false;
  
  // let awsWsClient, clientConnection, sessionId;
  app.locals[`awsWsClient_${originalUuid}`];   // Client WebSocket to AWS Transcribe for both Vonage WebSockets 0 and 1
  app.locals[`clientConnection_${originalUuid}`]; // Client connection to AWS Transcribe for both Vonage WebSockets 0 and 1
  let sessionId;

  app.locals[`queue_${originalUuid}_0`] = []; // payload queue for WebSocket 0
  app.locals[`queue_${originalUuid}_1`] = []; // payload queue for WebSocket 1
  app.locals[`last_msg_${originalUuid}_0`] = null; // last message received on WebSocket 0
  app.locals[`last_msg_${originalUuid}_1`] = null; // last message received on WebSocket 1
  app.locals[`mixPayload_{originalUuid}`] = Buffer.alloc(1280);

  // sessionId value needs to be in format
  // [a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}
  // e.g. 12345678-1234-1234-1234-123456789012
  
  // sample pstn call uuid: 4c3576db1586863d52d572274ba264d1
  // after transformation: 4c3576db-1586-863d-52d5-72274ba264d1

  // transform to above format, for all calls (incoming/outgoing pstn, client sdk, sip)
  // TO DO: check client SDK uuids, SIP call uuids, what format are they?
  //        if they are different we will need mapping between original call uuid with sessionId

  if (peerUuid.length == 36) {

    sessionId = peerUuid;

  } else {

    sessionId = peerUuid.substring(0, 8) + '-' +
                peerUuid.substring(8, 12) + '-' +
                peerUuid.substring(12, 16) + '-' +
                peerUuid.substring(16, 20) + '-' +
                peerUuid.substring(20, 32);

  }
  
  // TO DO: test calls with duration of over 300 sec

  // transcribe 2-channel audio
  const awsServiceOptions = {
    query: 'language-code=en-US' +
      '&media-encoding=' + mediaEncoding +
      '&sample-rate=' + samplingRate +
      '&session-id=' + sessionId +
      '&enable-channel-identification=true' +
      '&number-of-channels=2',
    expires: 300 // X-Amz-Expires = 300 max, or we get error 'X-Amz-Expires must be less than a week (in seconds) that is 604800' 
  };

  // // medical transcribe 2-channel audio
  // const awsServiceOptions = {
  //   query: 'language-code=en-US' +
  //     '&media-encoding=' + mediaEncoding +
  //     '&sample-rate=' + samplingRate +
  //     '&session-id=' + sessionId +
  //     '&enable-channel-identification=true' +
  //     '&specialty=' + specialty +
  //     '&type=' + type +
  //     '&number-of-channels=2',
  //   expires: 300 // X-Amz-Expires = 300 max, or we get error 'X-Amz-Expires must be less than a week (in seconds) that is 604800' 
  // };

  console.log('awsHost:', awsHost);
  console.log('awsPath:', awsPath);
  console.log('awsService:', awsService);
  console.log('awsServiceOptions', awsServiceOptions);

  const preSignedUrl = v4.createPresignedURL('GET', awsHost, awsPath, awsService, '', awsServiceOptions);
  console.log('preSignedUrl:', preSignedUrl);

  // replace 'https' with 'wss'
  const awsWsUrl = 'wss' + preSignedUrl.substring(5);

  console.log('awsWsUrl:', awsWsUrl);

  const _awsWsClient = new WebSocketClient();;
  // console.log('awsWsClient:', _awsWsClient);

  app.locals[`awsWsClient_${originalUuid}`] = _awsWsClient;

  app.locals[`awsWsClient_${originalUuid}`].on('connectFailed', (error) => {
      console.log('awsWsClient connect Error: ' + error.toString());
  });

  app.locals[`awsWsClient_${originalUuid}`].on('connect', (_clientConnection) => {
    console.log('\n>>> awsWsClient connected');
    app.locals[`clientConnection_${originalUuid}`] = _clientConnection;
    // console.log('\n>>> awsWsClient connection:', connection);
    console.log('\n>>> awsWsClient connection:', app.locals[`clientConnection_${originalUuid}`]);
    console.log('\n>>> awsWsClient:', app.locals[`awsWsClient_${originalUuid}`]);

    app.locals[`clientConnection_${originalUuid}`].on('message', (message) => {
      // console.log('\n>>> awsWsClient received message:', message);

      let messageWrapper = eventStreamMarshaller.unmarshall(Buffer.from(message.binaryData));

      // console.log('messageWrapper:', messageWrapper);
      // console.log('messageWrapper.headers:', messageWrapper.headers);

      let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));

      // console.log('messageBody:', messageBody);

      if (messageWrapper.headers[":message-type"].value === "event") {
        let results = messageBody.Transcript.Results;

        if (results.length > 0) {
          // onChunk(results[0]);

          // console.log('\n>>> Amazon Transcribe full results:', results);
          // console.log('\n>>> Amazon Transcribe results - array 1st entry:', results[0] );
          // console.log('\n>>> Amazon Transcribe results - array 1st entry - items:', results[0].Alternatives[0].Items );

          if (!results[0].IsPartial) {
            // console.log('StartTime:', results[0].StartTime);
            // console.log('EndTime:', results[0].EndTime);
            const transcript = results[0].Alternatives[0].Transcript;
            const audioChannel = results[0].ChannelId;
            // console.log('AWS Transcribe results:', results[0]);
            console.log('\n>>> Transcript on channel ' + audioChannel + ' - ' + transcript);
          }
        }
      }
      else {
        transcribeException = true;
        console.log(messageBody.Message);
        // onError(messageBody.Message);
        // toggleStartStop();
      }

      // if (stopped) {
      //   delayedStop();
      // }

    });

    app.locals[`clientConnection_${originalUuid}`].on('close', () => {
      console.log('\n>>> awsWsClient closed');
    });

  });

  app.locals[`awsWsClient_${originalUuid}`].connect(awsWsUrl);
 
  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket settings:", msg);

      // const wsconfig = JSON.parse(msg);
      // callerNumber = wsconfig.caller_number;
    
    } else {

      sendPayloadToAws(0, originalUuid, msg);

    }

  });

  //--

  ws.on('close', async () => {
    
    console.log("socket closed");

  });

});

//-------------- Second call leg --------------
//-- Agent call leg for this instance -----

app.ws('/socket1', async (ws, req) => {

  // manager.addWebsocket(ws);
  // console.log("Global variable 1:", req.app.locals.globalvar1);
  // app.locals.globalvar1 = "value_1";

  const originalUuid = req.query.original_uuid; 
  const peerUuid = req.query.peer_uuid;

  // let callerNumber; // value set in  ws.on('message' ... section

  //-- Next 2 parameters apply to Amazon Transcribe Medical

  // possible values at this time: PRIMARYCARE, CARDIOLOGY, NEUROLOGY, ONCOLOGY, RADIOLOGY, or UROLOGY
  // const specialty = req.query.specialty;

  // possible value: DICTATION, CONVERSATION
  // const type = req.query.type;

  console.log('>>> websocket connected with');
  console.log('original call uuid:', originalUuid);
  console.log('peer uuid:', peerUuid);

  const webhookUrl = req.query.webhook_url;

  console.log('>>> webhookUrl:', webhookUrl);

  //-- if set by client application
  // const userName = req.query.user_name;
  
  //-- if set by client application
  // const userId = req.query.user_id;

  //-- if set by client application
  // const confName = req.query.conference_name;

  //-- if client application set custom query parameters, those values will be returned on reply webhooks to client application
  let xCustomFields = [];
  let customQueryParams = '';

  for (const queryParameter in req.query){    
    if (`${queryParameter}`.substring(0, 2) == 'x_') {
      xCustomFields.push(`"${queryParameter}": "${req.query[`${queryParameter}`]}"`);
    }
  };

  customQueryParams = "{" + xCustomFields.join(", ") + "}";
  console.log('>>> websocket custom query parameters:', customQueryParams);
 
  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket settings:", msg);

      // const wsconfig = JSON.parse(msg);
      // callerNumber = wsconfig.caller_number;
    
    } else {

      sendPayloadToAws(1, originalUuid, msg);

    }

  });

  //--

  ws.on('close', async () => {
    
    console.log("socket closed");

  });

});

//==================================================

const port = process.env.PORT || 6000;

app.listen(port, () => console.log(`\nAWS Transcribe connector running on port ${port}.`));

//------------

