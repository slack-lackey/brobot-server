// Load environment variables from `.env` file
require('dotenv').config();

const { createEventAdapter } = require('@slack/events-api');
const { WebClient } = require('@slack/web-api');
const passport = require('passport');
const LocalStorage = require('node-localstorage').LocalStorage;
const SlackStrategy = require('@aoberoi/passport-slack').default.Strategy;

const http = require('http');
const express = require('express');

const { createMessageAdapter } = require('@slack/interactive-messages');
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);

const superagent = require('superagent');


// *** Initialize event adapter using signing secret from environment variables ***
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET, {
  includeBody: true
});



// Initialize a Local Storage object to store authorization info
// NOTE: This is an insecure method and thus for demo purposes only!
const botAuthorizationStorage = new LocalStorage('./storage');

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

// Initialize Add to Slack (OAuth) helpers
passport.use(new SlackStrategy({
  clientID: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  skipUserProfile: true,
}, (accessToken, scopes, team, extra, profiles, done) => {
  botAuthorizationStorage.setItem(team.id, extra.bot.accessToken);
  done(null, {});
}));

// Initialize an Express application
const app = express();

// Plug the Add to Slack (OAuth) helpers into the express app
app.use(passport.initialize());
app.get('/', (req, res) => {
  res.send('<a href="/auth/slack"><img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>');
});
app.get('/auth/slack', passport.authenticate('slack', {
  scope: ['bot']
}));
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
app.use('/slack/events', slackEvents.expressMiddleware());

// *** Plug the interactive message adapter into the express app as middleware ***
app.use('/slack/actions', slackInteractions.requestListener());




// *** Attach listeners to the event adapter ***

// *** Greeting any user that says "hi" ***
slackEvents.on('message', (message, body) => {

  // *** Ask if user wants to save a Gist when it detects a code block ***
  // Looks for 3 backticks in every message
  if (!message.subtype && message.text.indexOf('```') >= 0) {
    console.log('backtick message:', message);
    const slack = getClientByTeamId(body.team_id);
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
      .catch(err => console.log(err))
  }

  // *** Save a gist when 'get gists' is in a message ***
  if (!message.subtype && message.text.indexOf('get gists') >= 0) {
    console.log('get gists message:', message);
    const slack = getClientByTeamId(body.team_id);

    return superagent.get('https://api.github.com/users/SlackLackey/gists')
      .then(res => {
        // console.log(res.body[0].url);
        const url = res.body[0].url;
        slack.chat.postMessage({
          channel: message.channel,
          text: 'Your gists are here:\n' + url
        });
      })
      .catch(err => console.log(err))
  }

  if (!message.subtype && message.text.indexOf('save gist') >= 0) {
    console.log('save gist message:', message);
    // console.log('save gist message:', message);
    const slack = getClientByTeamId(body.team_id);

    return superagent.post(`${process.env.BOT_API_SERVER}/createGist`)
      .send(message)
      .then(res => {
        console.log('response body URL:', res);
        slack.chat.postMessage({
          channel: message.channel,
          text: 'I saved it as a gist for you. You can find it here:\n' + res.text
        });
      })
      .catch(err => console.log(err))
  }


});


// Handle interactions from messages with an `action_id` of `save_gist`
slackInteractions.action({ actionId: 'save_gist' }, (payload, respond) => {
  // `payload` contains information about the action
  // see: https://api.slack.com/docs/interactive-message-field-guide#action_url_invocation_payload
  // console.log('payload 176:', payload);
  console.log('original message:', JSON.parse(payload.actions[0].value));

  const message = JSON.parse(payload.actions[0].value)

  return superagent.post(`${process.env.BOT_API_SERVER}/createGist`)
    .send(message)
    .then((res) => {
      respond({ 
        text: 'I saved it as a gist for you. You can find it here:\n' + res.text,
        replace_original: true 
      });
    })
    .catch((error) => {
      respond({ text: 'Sorry, there\'s been an error. Try again later.',  replace_original: true });
    });



  // `respond` is a function that can be used to follow up on the action with a message
  // respond({
  //   text: 'Success!',
  // });

  // The return value is used to update the message where the action occurred immediately.
  // Use this to items like buttons and menus that you only want a user to interact with once.
  // return {
  //   text: 'Processing...',
  // }
});













// *** Handle errors ***
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
