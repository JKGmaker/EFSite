# Netlify Deployment

## 1. Upload to Netlify
Deploy this folder directly to Netlify.

## 2. Add Environment Variable
In Netlify Dashboard:

Site Settings -> Environment Variables

Add:

FOOTBALL_API_KEY=your_api_key_here

## 3. Function URL
/.netlify/functions/football-predictions

## 4. Local Development
Install Netlify CLI:

npm install -g netlify-cli

Run locally:

netlify dev
