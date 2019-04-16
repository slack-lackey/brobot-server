'use strict';

// Load environment variables from `.env` file
require('dotenv').config();

/***************************************************
---------- APPLICATION DEPENDENCIES ----------
***************************************************/

const express = require('express');
const superagent = require('superagent');

// Slack APIs
const { WebClient } = require('@slack/web-api');
const { createEventAdapter } = require('@slack/events-api');
const { createMessageAdapter } = require('@slack/interactive-messages');

// Dependencies for OAuth
const passport = require('passport');
const LocalStorage = require('node-localstorage').LocalStorage;
const SlackStrategy = require('@aoberoi/passport-slack').default.Strategy;

/***************************************************
---------- APPLICATION SETUP ----------
***************************************************/

// Initialize an Express application
const app = express();

// Initialize interactive message adapter using signing secret from environment variables
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);

// Initialize event adapter using signing secret from environment variables
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET, {
  includeBody: true
});

// Initialize a Local Storage object to store authorization info
// NOTE: This is an insecure method and thus for demo purposes only!
const botAuthorizationStorage = new LocalStorage('./storage');

/***************************************************
---------- HELPER FUNCTIONS ----------
***************************************************/

// Helpers to cache and lookup appropriate client
// NOTE: Not enterprise-ready. if the event was triggered inside a shared channel, this lookup
// could fail but there might be a suitable client from one of the other teams that is within that
// shared channel.
const clients = {};
function getClientByTeamId(teamId) {
  if (!clients[teamId] && botAuthorizationStorage.getItem(teamId)) {
    clients[teamId] = new WebClient(botAuthorizationStorage.getItem(teamId));
  }
  if (clients[teamId]) {
    return clients[teamId];
  }
  return null;
}

/***************************************************
---------- OAUTH MIDDLEWARE & ROUTES ----------
***************************************************/
// See docs for OAuth 2.0 in Slack
// https://api.slack.com/docs/oauth

// Initialize Add to Slack (OAuth) helpers
passport.use(new SlackStrategy({
  clientID: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  skipUserProfile: true,
}, (accessToken, scopes, team, extra, profiles, done) => {
  botAuthorizationStorage.setItem(team.id, extra.bot.accessToken);
  done(null, {});
}));

// Plug the Add to Slack (OAuth) helpers into the express app
app.use(passport.initialize());

// Route for "Add to Slack" button needed to complete app/bot installation
app.get('/', (req, res) => {
  res.send('<a href="/auth/slack"><img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>');
});


app.get('/auth/slack', passport.authenticate('slack', {
  scope: ['bot']
}));

// Corresponds to a "Redirect URL" in App Dashboard > Features > OAuth & Permissions
app.get('/auth/slack/callback',
  passport.authenticate('slack', { session: false }),
  (req, res) => {
    res.send('<p>Greet and React was successfully installed on your team.</p>');
  },
  (err, req, res, next) => {
    res.status(500).send(`<p>Greet and React failed to install</p> <pre>${err}</pre>`);
  }
);

// *** Plug the event adapter into the express app as middleware ***
// Corresponds to the "Request URL" in App Dashboard > Features > Event Subscriptions
// Ex: https://your-deployed-bot.com/slack/events
app.use('/slack/events', slackEvents.expressMiddleware());

// *** Plug the interactive message adapter into the express app as middleware ***
// Corresponds to the "Request URL" in App Dashboard > Features > Interactive Components
// Ex: https://your-deployed-bot.com/slack/actions
app.use('/slack/actions', slackInteractions.requestListener());


/***************************************************
---------- SLACK CHANNEL EVENT LISTENERS ----------
***************************************************/
// Attaches listeners to the event adapter 

// Listens for every "message" event
slackEvents.on('message', (message, body) => {
  // console.log('heard message:', message);
  // console.log('message body:', body);


  // ***** If message contains 3 backticks, asks if user wants to save a Gist with buttons
  if (!message.subtype && message.text.indexOf('```') >= 0) {

    // Get the user's display name
    const slack = getClientByTeamId(body.team_id);
    let token = botAuthorizationStorage.getItem(body.team_id);
    return slack.users.info({
      "token": token,
      "user": message.user
    })
      .then(res => {
        // attach display name to the message object
        message.username = res.user.profile.display_name

        // Send a message and buttons to save/not save to the user
        // entire message object is passed in as the "value" of the "save" button
        slack.chat.postMessage({
          channel: message.channel,
          text: `Hey, <@${message.user}>, looks like you pasted a code block. Want me to save it for you as a Gist? :floppy_disk:`,
          attachments: [
            {
              "blocks": [
                {
                  "type": "actions",
                  "elements": [
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "emoji": true,
                        "text": "Yeah"
                      },
                      "value": JSON.stringify(message),
                      "action_id": "save_gist",
                      "style": "primary"
                    },
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "emoji": true,
                        "text": "Nah"
                      },
                      "value": "click_me_123",
                      "style": "danger"
                    }
                  ]
                }
              ]
            }
          ]
        })
      })

      .catch(err => console.log(err));
  }

  // ***** If message contains "get gists", send back a link from the GitHub API
  if (!message.subtype && message.text.indexOf('get gists') >= 0) {
    const slack = getClientByTeamId(body.team_id);

    return superagent.get('https://api.github.com/users/SlackLackey/gists')
      .then(res => {
        const url = res.body[0].url;
        slack.chat.postMessage({
          channel: message.channel,
          text: 'Your gists are here:\n' + url
        });
      })
      .catch(err => console.log(err))
  }

});

slackEvents.on('file_created', (fileEvent, body) => {
  console.log('file was created 196')
  console.log('fileEvent', fileEvent);

  const slack = getClientByTeamId(body.team_id);
  let token = botAuthorizationStorage.getItem(body.team_id);

  return slack.files.info({
    "token": token,
    "file": fileEvent.file_id
  })
    .then(file => {
      console.log('210 mode', file.file.mode)
      if (file.file.mode === 'snippet') {
        console.log('ITS A SNIPPET');
        // console.log('the whole file obj', file);
        console.log('channel to respond to:', file.file.channels[0])

        // CJ0MKER54 - billy & chris
        // CHW996DHC - everyone

        // Send a message and buttons to save/not save to the user
        // entire message object is passed in as the "value" of the "save" button
        slack.chat.postMessage({
          channel: file.file.channels[0],
          text: `Hey, <@${file.file.user}>, looks like you made a code snippet. Want me to save it for you as a Gist? :floppy_disk:`,
          attachments: [
            {
              "blocks": [
                {
                  "type": "actions",
                  "elements": [
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "emoji": true,
                        "text": "Yeah"
                      },
                      "value": fileEvent.file_id,
                      "action_id": "save_gist_snippet",
                      "style": "primary"
                    },
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "emoji": true,
                        "text": "Nah"
                      },
                      "value": "click_me_123",
                      "style": "danger"
                    }
                  ]
                }
              ]
            }
          ]
        })



      }
      // if (file.file)
    })
    .catch(err => console.error(err))

});

/***************************************************
---------- SLACK INTERACTIVE MESSAGES ----------
***************************************************/
// Attaches listeners to the interactive message adapter
// `payload` contains information about the action
// Block Kit Builder can be used to explore the payload shape for various action blocks:
// https://api.slack.com/tools/block-kit-builder

// ***** If block interaction "action_id" is "save_gist"
slackInteractions.action({ actionId: 'save_gist' }, (payload, respond) => {

  // Get the original message object (with the future Gist's content)
  const message = JSON.parse(payload.actions[0].value)

  // POST request to hosted API server which saves a Gist and returns a URL
  return superagent.post(`${process.env.BOT_API_SERVER}/createGist`)
    .send(message)
    .then((res) => {
      console.log('line 200')
      respond({
        text: 'I saved it as a gist for you. You can find it here:\n' + res.text,
        replace_original: true
      });
    })
    .catch((error) => {
      respond({ text: 'Sorry, there\'s been an error. Try again later.', replace_original: true });
    });

});


// ***** If block interaction "action_id" is "save_gist_snippet"
slackInteractions.action({ actionId: 'save_gist_snippet' }, (payload, respond) => {


  let file_id = payload.actions[0].value;
  console.log('file ID:', file_id);
  // Get the file from the id
  // const snippet = payload

  const slack = getClientByTeamId(body.team_id);
  let token = botAuthorizationStorage.getItem(body.team_id);

  console.log('token:', token);
  return slack.files.info({
    "token": token,
    "file": file_id
  })
    .then(file => {
      console.log('THE WHOLE FREAKIN SNIPPET', file)
    })
    .catch(err => console.error('ERROR on line 317', err))

  // Construct request to API server (in a nicely formatted object)

  // Make a superagent post request to the API server

  // Send Gist URL to user in Slack channel

});


// *** Handle Event API errors ***
slackEvents.on('error', (error) => {
  if (error.code === slackEventsApi.errorCodes.TOKEN_VERIFICATION_FAILURE) {
    // This error type also has a `body` propery containing the request body which failed verification.
    console.error(`An unverified request was sent to the Slack events Request URL. Request body: \
${JSON.stringify(error.body)}`);
  } else {
    console.error(`An error occurred while handling a Slack event: ${error.message}`);
  }
});


// Start the express application
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server up on port ${port}`);
});
