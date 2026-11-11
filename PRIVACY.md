# Nova Agent privacy policy

Last updated: November 11, 2026

Nova Agent is a Chrome extension made by students as a course project. It is not affiliated with or endorsed by Villanova University or D2L. This page says what the extension reads, where it keeps it, and when anything leaves your device.

## The short version

- Nova reads your own Brightspace courses through the session you are already signed in to. It never changes anything in Brightspace.
- What it reads stays on your device.
- Nothing is sent anywhere unless you turn on Ask Nova. The panel shows you what will be sent before you turn it on.
- There are no ads, no analytics, and no tracking. Your data is not sold or shared for any purpose other than answering your questions.

## What Nova reads

Nova runs only on `https://brightspace.villanova.edu`. It asks Brightspace for a fixed list of read-only pages of your own data:

- Your Brightspace user id, used only to keep one account's data apart from another's on the same device
- The courses you are enrolled in
- Assignment and quiz titles, due dates, submission status, points, and scores
- Announcement titles and dates
- The names and sizes of files attached to assignments

Nova does not read your password or your Brightspace cookies, does not read other websites, and does not read your browsing history.

Two more things are read only when you ask for them:

- **An assignment file.** When you press Read, or allow it for a question, the file is downloaded through your Brightspace session and its text is extracted on your device. The file itself is not kept.
- **A course's materials.** When you turn a course on under Course materials, the files in its Content area are downloaded the same way and their text is kept on your device.

## What is kept on your device

Everything above is stored in the extension's own storage in your browser, along with what you add yourself: items you marked done, deadlines you typed in, your settings, and your ratings of answers. Conversations with Ask Nova are kept only if you turn saving on.

You can delete all of it at any time with **Clear local Nova data** in the panel's menu. Removing the extension deletes it too.

## When data leaves your device

By default it never does. It leaves only in these cases, each of which you turn on yourself.

### Ask Nova

Ask Nova is off until you turn it on. When it is on, each question you ask is sent to the Nova server whose address is in the Ask settings, together with a short copy of your course data so the question can be answered:

- Course names and codes
- Assignment and quiz titles, due dates, status, points, and scores
- Announcement titles
- Recent changes
- Items you marked done and deadlines you added
- The names of assignment files, and the names of topics in courses whose materials you turned on
- Earlier messages of the same conversation

The text of a file or of course materials is sent only for a question that needs it, only after you allowed it, and only the part that is needed.

Never sent: your Brightspace password or cookies, your name, your Brightspace user id, the full text of announcements, and the files themselves.

The Nova server passes the question and that data to an AI model through OpenRouter to write the answer. OpenRouter and the model's provider handle it under their own terms, and some free models may use what they receive to improve their service. The Nova server keeps the data in memory only while it answers, and its logs record counts, not content.

**Who runs the server.** The default address is a server on your own computer. As of the date above, this project does not run a public Nova server. If someone gives you the address of a server they run, they are the one who receives what you send to it.

### Signing in to a shared Nova server

The version of Nova in the Chrome Web Store as of the date above does not include Google sign-in. A build that does can sign in to a Nova server run for a class. If you sign in, that server stores:

- Your email address and Google account id
- How many tokens each of your questions used, and when
- A scrambled copy of your sign-in token

It stores nothing about your courses, with one exception you choose: if you turn on **Also keep them on the Nova server**, your saved conversations are copied to it so they follow you to another device. Turning that off deletes the copies.

**Sign out** ends the sign-in. **Delete my account** in the Ask settings removes your account and everything that server stored for you.

## Google user data

A build with Google sign-in uses it only to identify you to a shared Nova server, and requests only your basic identity and email address. The use of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## What Nova does not do

- It does not sell your data or share it with advertisers or data brokers.
- It does not use your data for anything other than showing you your coursework and answering your questions.
- It does not use your data to determine creditworthiness or for lending.
- It does not write to Brightspace, submit work, or act on your behalf.

## Children

Nova is made for university students and is not directed at children under 13.

## Changes to this policy

Changes are published on this page with a new date at the top.

## Contact

Questions and requests can be opened at https://github.com/khanhhlee05/nova-agent/issues.
