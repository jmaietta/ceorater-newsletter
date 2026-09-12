/**
 * CEORater Newsletter Service
 * Automated email newsletter triggered by:
 *   1. GitHub webhook - records new articles
 *   2. Render webhook - processes articles after deploy completes
 */

const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const { transformArticle, extractSubject } = require('./transform');

// Initialize Express
const app = express();
app.use(express.json());

// CORS - allow requests from ceorater.com
app.use((req, res, next) => {
  const allowedOrigins = ['https://www.ceorater.com', 'https://ceorater.com'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Initialize Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Load email templates
const emailTemplate = fs.readFileSync(path.join(__dirname, 'email-template.html'), 'utf-8');
const previewBanner = fs.readFileSync(path.join(__dirname, 'preview-banner.html'), 'utf-8');

// Environment variables
const {
  EMAIL_FROM = 'news@ceorater.com',
  EMAIL_USER,
  EMAIL_PASS,
  GITHUB_WEBHOOK_SECRET,
  RENDER_WEBHOOK_SECRET,
  BASE_URL,
  ADMIN_EMAIL = 'jmaietta@ceorater.com'
} = process.env;

// Configure email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

/**
 * Verify GitHub webhook signature
 */
function verifyGitHubSignature(payload, signature) {
  if (!GITHUB_WEBHOOK_SECRET) return true; // Skip in dev
  
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest));
  } catch {
    return false;
  }
}

/**
 * Verify Render webhook secret (simple token match)
 */
function verifyRenderSecret(providedSecret) {
  if (!RENDER_WEBHOOK_SECRET) return true; // Skip in dev
  return providedSecret === RENDER_WEBHOOK_SECRET;
}

/**
 * Generate secure random token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================
// WEBHOOK ENDPOINTS
// ============================================================

/**
 * POST /github-webhook - Receives GitHub push events
 * Records new articles as "queued" - does NOT send emails yet
 */
app.post('/github-webhook', async (req, res) => {
  try {
    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    if (!verifyGitHubSignature(req.body, signature)) {
      console.error('Invalid GitHub webhook signature');
      return res.status(401).send('Invalid signature');
    }
    
    const payload = req.body;
    
    // Only process push events to main branch
    if (payload.ref !== 'refs/heads/main') {
      return res.status(200).send('Not main branch, ignoring');
    }
    
    // Find new articles in news/ directory
    const newArticles = [];
    for (const commit of payload.commits || []) {
      for (const file of commit.added || []) {
        if (file.startsWith('news/') && file.endsWith('.html') && file !== 'news/index.html') {
          newArticles.push(file);
        }
      }
    }
    
    if (newArticles.length === 0) {
      return res.status(200).send('No new articles found');
    }
    
    console.log(`GitHub webhook: Found ${newArticles.length} new article(s):`, newArticles);
    
    // Queue each article for processing (don't process yet - wait for Render)
    for (const articlePath of newArticles) {
      const articleFilename = path.basename(articlePath);
      
      // Check if already sent
      const sentDoc = await db.collection('sent_articles').doc(articleFilename).get();
      if (sentDoc.exists && sentDoc.data().status === 'sent') {
        console.log(`Article ${articleFilename} already sent, skipping`);
        continue;
      }
      
      // Queue the article
      await db.collection('queued_articles').doc(articleFilename).set({
        articlePath,
        articleFilename,
        queuedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'queued'
      });
      
      console.log(`Queued article: ${articleFilename}`);
    }
    
    res.status(200).send(`Queued ${newArticles.length} article(s). Waiting for Render deploy.`);

  } catch (error) {
    console.error('GitHub webhook error:', error);
    res.status(500).send('Internal error');
  }
});

/**
 * POST /render-webhook - Receives Render deploy complete events
 * Processes all queued articles and sends preview emails
 */
app.post('/render-webhook', async (req, res) => {
  try {
    // Verify secret (passed as query param or header)
    const providedSecret = req.query.secret || req.headers['x-render-secret'];
    if (!verifyRenderSecret(providedSecret)) {
      console.error('Invalid Render webhook secret');
      return res.status(401).send('Invalid secret');
    }
    
    // Check if this is the CEORater static site deploy
    const payload = req.body;
    const serviceName = payload?.data?.serviceName;
    const status = payload?.data?.status;
    const eventType = payload?.type;
    
    console.log(`Render webhook received: service=${serviceName}, type=${eventType}, status=${status}`);
    
    // Only process successful deploys from CEORater static site
    if (serviceName !== 'CEORater') {
      console.log(`Ignoring deploy from ${serviceName} (not CEORater)`);
      return res.status(200).send('Ignored - not CEORater');
    }
    
    if (eventType !== 'deploy_ended') {
      console.log(`Ignoring event type ${eventType} (not deploy_ended)`);
      return res.status(200).send('Ignored - not deploy_ended');
    }
    
    if (status !== 'succeeded') {
      console.log(`Ignoring deploy with status ${status} (not succeeded)`);
      return res.status(200).send('Ignored - deploy not succeeded');
    }
    
    console.log('CEORater deploy succeeded! Processing queued articles...');
    
    // Get all queued articles
    const queuedSnapshot = await db.collection('queued_articles')
      .where('status', '==', 'queued')
      .get();
    
    if (queuedSnapshot.empty) {
      console.log('No queued articles to process');
      return res.status(200).send('No queued articles');
    }
    
    console.log(`Found ${queuedSnapshot.size} queued article(s)`);
    
    // Process each queued article
    let processed = 0;
    let errors = 0;
    
    for (const doc of queuedSnapshot.docs) {
      const { articlePath, articleFilename } = doc.data();
      
      try {
        await processArticle(articlePath, articleFilename);
        
        // Mark as processed (remove from queue)
        await doc.ref.update({ status: 'processed', processedAt: admin.firestore.FieldValue.serverTimestamp() });
        processed++;
        
      } catch (err) {
        console.error(`Error processing ${articleFilename}:`, err.message);
        await doc.ref.update({ status: 'error', error: err.message });
        errors++;
      }
    }
    
    res.status(200).send(`Processed ${processed} article(s), ${errors} error(s)`);
    
  } catch (error) {
    console.error('Render webhook error:', error);
    res.status(500).send('Internal error');
  }
});

/**
 * Process a single article - fetch, transform, send preview
 */
async function processArticle(articlePath, articleFilename) {
  // Double-check not already sent
  const sentDoc = await db.collection('sent_articles').doc(articleFilename).get();
  if (sentDoc.exists && sentDoc.data().status === 'sent') {
    console.log(`Article ${articleFilename} already sent, skipping`);
    return;
  }
  
  // Fetch article from live site
  const articleUrl = `https://www.ceorater.com/${articlePath}`;
  console.log(`Fetching article: ${articleUrl}`);
  
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(articleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch article: ${response.status}`);
  }
  
  const html = await response.text();
  
  // Check for draft meta tag
  if (html.includes('name="draft"') || html.includes("name='draft'")) {
    console.log(`Article ${articleFilename} is a draft, skipping`);
    return;
  }
  
  // Transform article
  const { title, content, heroImage } = transformArticle(html, articlePath);
  
  if (!title) {
    throw new Error('Article has no title');
  }
  
  // Get subscriber count for preview
  const subscribersSnapshot = await db.collection('subscribers').get();
  const subscriberCount = subscribersSnapshot.size;
  
  // Generate approval token
  const token = generateToken();
  const tokenExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
  
  // Store pending article
  await db.collection('pending_articles').doc(articleFilename).set({
    articlePath,
    articleUrl,
    title,
    content,
    heroImage,
    token,
    tokenExpiry,
    status: 'pending',
    previewSentAt: admin.firestore.FieldValue.serverTimestamp(),
    previewSentTo: ADMIN_EMAIL
  });
  
  // Build preview email
  const approveUrl = `${BASE_URL}/approve?token=${token}`;
  const cancelUrl = `${BASE_URL}/cancel?token=${token}`;
  
  const previewBannerHtml = previewBanner
    .replace('{{SUBSCRIBER_COUNT}}', subscriberCount.toString())
    .replace('{{APPROVE_URL}}', approveUrl)
    .replace('{{CANCEL_URL}}', cancelUrl);
  
  const emailHtml = emailTemplate
    .replace('{{SUBJECT}}', title)
    .replace('{{PREVIEW_BANNER}}', previewBannerHtml)
    .replace('{{CONTENT}}', content)
    .replace('{{ARTICLE_URL}}', articleUrl)
    .replace('{{UNSUBSCRIBE_URL}}', `${BASE_URL}/unsubscribe?email=${encodeURIComponent(ADMIN_EMAIL)}`);
  
  // Send preview to admin
  await transporter.sendMail({
    from: `"CEORater News" <${EMAIL_FROM}>`,
    to: ADMIN_EMAIL,
    subject: `[PREVIEW] ${title}`,
    html: emailHtml
  });
  
  console.log(`Preview sent to ${ADMIN_EMAIL} for: ${title}`);
}

// ============================================================
// APPROVAL ENDPOINTS
// ============================================================

/**
 * POST /resend - regenerate the preview for one article.
 *
 * The queue only ever fills from a file appearing in a push's `added` list, so a
 * preview could be produced exactly once per article, ever. When one came out
 * wrong -- the site's dark theme inlined white headings into the email's white
 * content cell, so every heading was invisible -- there was no way to get a
 * corrected proof without inventing a commit to re-add the file. Owning the
 * newsletter should not mean fighting the tooling to see your own article.
 *
 * Regenerates from the live page, so it always reflects what is deployed right
 * now rather than whatever was stored when the first preview ran. Refuses an
 * article already sent to subscribers -- that is what /approve is for, and
 * resending would mean a second delivery to everyone.
 *
 * Body or query: { articlePath: "news/example.html" }
 * Auth: the same x-render-secret the deploy webhook uses.
 */
app.post('/resend', async (req, res) => {
  try {
    const secret = req.headers['x-render-secret'] || (req.query && req.query.secret);
    if (!verifyRenderSecret(secret)) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const articlePath = (req.body && req.body.articlePath) || (req.query && req.query.articlePath);
    if (!articlePath || typeof articlePath !== 'string') {
      return res.status(400).json({ error: 'articlePath is required, e.g. news/example.html' });
    }
    // Only ever a news article on this site, and never a traversal.
    if (!/^news\/[A-Za-z0-9._-]+\.html$/.test(articlePath) || articlePath.includes('..')) {
      return res.status(400).json({ error: 'articlePath must look like news/example.html' });
    }
    if (articlePath === 'news/index.html') {
      return res.status(400).json({ error: 'news/index.html is the listing page, not an article' });
    }

    const articleFilename = path.basename(articlePath);

    const sentDoc = await db.collection('sent_articles').doc(articleFilename).get();
    if (sentDoc.exists && sentDoc.data().status === 'sent') {
      return res.status(409).json({
        error: 'Already sent to subscribers. Resending would deliver it twice.',
        articleFilename
      });
    }

    console.log(`Resend requested for ${articlePath}`);
    await processArticle(articlePath, articleFilename);

    return res.status(200).json({
      ok: true,
      articlePath,
      message: `Preview regenerated and sent to ${ADMIN_EMAIL}.`
    });
  } catch (error) {
    console.error('Resend error:', error);
    return res.status(500).json({ error: String(error && error.message || error) });
  }
});

/**
 * GET /approve - Approve and send to all subscribers
 */
app.get('/approve', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).send('Missing token');
    }
    
    // Find pending article with this token
    const snapshot = await db.collection('pending_articles')
      .where('token', '==', token)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return res.status(404).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h1>Link Expired or Already Used</h1>
            <p>This approval link is no longer valid. The article may have already been sent or the link expired.</p>
            <a href="https://www.ceorater.com/news/">Return to News</a>
          </body>
        </html>
      `);
    }
    
    const doc = snapshot.docs[0];
    const article = doc.data();
    
    // Check expiry
    if (article.tokenExpiry.toDate() < new Date()) {
      return res.status(410).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h1>Link Expired</h1>
            <p>This approval link has expired (72 hour limit). Please re-commit the article to generate a new preview.</p>
          </body>
        </html>
      `);
    }
    
    // Get all subscribers
    const subscribersSnapshot = await db.collection('subscribers').get();
    const subscribers = subscribersSnapshot.docs.map(d => d.data().email);
    
    if (subscribers.length === 0) {
      return res.status(200).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h1>No Subscribers</h1>
            <p>There are no subscribers to send to. Add subscribers first.</p>
          </body>
        </html>
      `);
    }
    
    // Build final email (no preview banner)
    const emailHtml = emailTemplate
      .replace('{{SUBJECT}}', article.title)
      .replace('{{PREVIEW_BANNER}}', '')
      .replace('{{CONTENT}}', article.content)
      .replace('{{ARTICLE_URL}}', article.articleUrl)
      .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, `${BASE_URL}/unsubscribe?email=RECIPIENT_EMAIL`);
    
    // Send to all subscribers
    let sent = 0;
    let failed = 0;
    
    for (const email of subscribers) {
      try {
        const personalizedHtml = emailHtml.replace('RECIPIENT_EMAIL', encodeURIComponent(email));
        
        await transporter.sendMail({
          from: `"CEORater News" <${EMAIL_FROM}>`,
          to: email,
          subject: article.title,
          html: personalizedHtml
        });
        
        sent++;
        console.log(`Sent to: ${email}`);
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 100));
        
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
        failed++;
      }
    }
    
    // Mark as sent
    await doc.ref.update({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp() });
    
    // Also record in sent_articles to prevent future re-sends
    await db.collection('sent_articles').doc(path.basename(article.articlePath)).set({
      articlePath: article.articlePath,
      title: article.title,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'sent',
      recipientCount: sent
    });
    
    console.log(`Newsletter sent: ${sent} successful, ${failed} failed`);
    
    res.status(200).send(`
      <html>
        <head>
          <style>
            body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px; background: #f5f5f7; }
            .card { background: white; max-width: 500px; margin: 0 auto; padding: 48px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            h1 { color: #16a34a; margin-bottom: 16px; }
            .count { font-size: 48px; font-weight: bold; color: #1a1a1a; }
            .label { color: #6b7280; margin-bottom: 24px; }
            a { color: #2563eb; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✓ Newsletter Sent!</h1>
            <div class="count">${sent}</div>
            <div class="label">subscribers received "${article.title}"</div>
            ${failed > 0 ? `<p style="color: #dc2626;">${failed} failed to send</p>` : ''}
            <p><a href="https://www.ceorater.com/news/">View News Page</a></p>
          </div>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).send('Internal error');
  }
});

/**
 * GET /cancel - Skip this article (don't send)
 */
app.get('/cancel', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).send('Missing token');
    }
    
    // Find pending article with this token
    const snapshot = await db.collection('pending_articles')
      .where('token', '==', token)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return res.status(404).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h1>Link Expired or Already Used</h1>
            <p>This link is no longer valid.</p>
          </body>
        </html>
      `);
    }
    
    const doc = snapshot.docs[0];
    const article = doc.data();
    
    // Mark as cancelled
    await doc.ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
    
    // Record in sent_articles to prevent future auto-sends
    await db.collection('sent_articles').doc(path.basename(article.articlePath)).set({
      articlePath: article.articlePath,
      title: article.title,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'cancelled'
    });
    
    res.status(200).send(`
      <html>
        <head>
          <style>
            body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px; background: #f5f5f7; }
            .card { background: white; max-width: 500px; margin: 0 auto; padding: 48px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            h1 { color: #6b7280; margin-bottom: 16px; }
            a { color: #2563eb; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Article Skipped</h1>
            <p>"${article.title}" will not be sent to subscribers.</p>
            <p style="color: #6b7280; font-size: 14px;">To send this article later, you'll need to manually re-enable it in Firestore.</p>
            <p><a href="https://www.ceorater.com/news/">View News Page</a></p>
          </div>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Cancel error:', error);
    res.status(500).send('Internal error');
  }
});

// ============================================================
// SUBSCRIBER ENDPOINTS
// ============================================================

/**
 * POST /subscribe - Add a new subscriber
 */
app.post('/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    // Check if already subscribed
    const existing = await db.collection('subscribers').doc(normalizedEmail).get();
    if (existing.exists) {
      return res.status(200).json({ message: 'Already subscribed' });
    }
    
    // Add subscriber
    await db.collection('subscribers').doc(normalizedEmail).set({
      email: normalizedEmail,
      subscribedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.status(200).json({ message: 'Subscribed successfully' });
    
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

/**
 * GET /unsubscribe - Remove a subscriber
 */
app.get('/unsubscribe', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).send('Missing email');
    }
    
    const normalizedEmail = decodeURIComponent(email).toLowerCase().trim();
    
    // Remove subscriber
    await db.collection('subscribers').doc(normalizedEmail).delete();
    
    res.status(200).send(`
      <html>
        <head>
          <style>
            body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px; background: #f5f5f7; }
            .card { background: white; max-width: 500px; margin: 0 auto; padding: 48px; border-radius: 16px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Unsubscribed</h1>
            <p>You've been removed from the CEORater newsletter.</p>
            <p><a href="https://www.ceorater.com/">Visit CEORater</a></p>
          </div>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).send('Error processing unsubscribe');
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

/**
 * GET / - Health check
 */
app.get('/', (req, res) => {
  res.status(200).send('CEORater Newsletter Service is running');
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Newsletter service listening on port ${PORT}`);
});
