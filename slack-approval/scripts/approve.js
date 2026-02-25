/**
 * slack-approval/scripts/approve.js
 *
 * Block Kit approval button utility for all OpenClaw skills.
 *
 * Source:
 *   - Block Kit JSON pattern: sickn33/slack-bot-builder (253★)
 *   - Node.js SDK: Slack official @slack/web-api + @slack/socket-mode
 *     https://slack.dev/node-slack-sdk/
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN         - Bot token (xoxb-...)
 *   SLACK_APP_TOKEN         - App-level token for Socket Mode (xapp-...)
 *   SLACK_APPROVER_USER_IDS - Comma-separated Slack user IDs allowed to approve
 *                             e.g. "UXXXXXXXXXX,UYYYYYYYYYY"
 */

const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');
const crypto = require('crypto');

// Fail fast: validate required environment variables at module load time
['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'].forEach(key => {
  if (!process.env[key]) throw new Error(`Required env var ${key} is not set`);
});

/**
 * Post a Block Kit approval message and wait for button click.
 *
 * @param {object} opts
 * @param {string} opts.channel  - Slack channel ID (e.g. 'C0XXXXXXXXX')
 * @param {string} opts.title    - Bold header text (max 200 chars)
 * @param {string} opts.detail   - Body text (mrkdwn, max 2000 chars)
 * @returns {Promise<'approved'|'denied'>}
 */
async function requestApproval({ channel, title, detail }) {
  // Input validation
  if (typeof channel !== 'string' || !/^C[A-Z0-9]{8,}$/.test(channel)) {
    throw new Error('Invalid channel ID format');
  }
  if (typeof title !== 'string' || title.length > 200) {
    throw new Error('title must be a string under 200 characters');
  }
  if (typeof detail !== 'string' || detail.length > 2000) {
    throw new Error('detail must be a string under 2000 characters');
  }

  const web = new WebClient(process.env.SLACK_BOT_TOKEN);
  const sm = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN });

  // Parse allowed approver IDs from env
  const approverIds = (process.env.SLACK_APPROVER_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  // Cryptographically random block ID to prevent collision across parallel calls
  const blockId = `approval_${crypto.randomBytes(16).toString('hex')}`;

  await sm.start();

  try {
    // Block Kit pattern from slack-bot-builder (sickn33, 253★)
    const posted = await web.chat.postMessage({
      channel,
      text: title, // fallback for notifications/accessibility
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${title}*\n${detail}` }
        },
        {
          type: 'actions',
          block_id: blockId,
          elements: [
            {
              type: 'button',
              action_id: 'approved',
              style: 'primary',
              text: { type: 'plain_text', text: '✅ 実行する' }
            },
            {
              type: 'button',
              action_id: 'denied',
              style: 'danger',
              text: { type: 'plain_text', text: '❌ キャンセル' }
            }
          ]
        }
      ]
    });

    // Wait for button click via Socket Mode
    return await new Promise((resolve) => {
      sm.on('slack_event', async ({ body, ack }) => {
        try {
          // Always ack immediately to prevent Socket Mode re-delivery / queue buildup
          await ack();

          if (
            body?.type !== 'block_actions' ||
            body?.actions?.[0]?.block_id !== blockId
          ) {
            return; // Not our event — already acked, just ignore
          }

          const userId = body?.user?.id;
          const action = body.actions[0].action_id; // 'approved' | 'denied'

          // Authorization check: only allowed users can approve
          if (approverIds.length > 0 && !approverIds.includes(userId)) {
            await web.chat.postEphemeral({
              channel,
              user: userId,
              text: '❌ あなたにはこの操作の権限がありません。'
            }).catch(() => {});
            return; // Do not resolve — keep waiting for authorized user
          }

          // Update message: replace buttons with result text (prevent double-click)
          const resultText = action === 'approved'
            ? `*${title}*\n✅ 実行しました`
            : `*${title}*\n❌ キャンセルしました`;

          await web.chat.update({
            channel,
            ts: posted.ts,
            text: resultText,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: resultText } }
            ]
          });

          resolve(action);
        } catch (err) {
          console.error('slack_event handler error:', err);
          resolve('denied'); // Fail safe: treat errors as denied
        }
      });
    });
  } finally {
    // Always disconnect on all exit paths (success or error)
    await sm.disconnect().catch(() => {});
  }
}

module.exports = { requestApproval };
