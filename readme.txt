🎮 LAN Bot

A Discord bot for managing LAN signups with limited seats, waitlist handling, and nickname enforcement.
Built on discord.js v14.

✨ Features

Users join via a signup panel (buttons):

🎟 LAN Seat (limited, default 48)

❓ Interested / Maybe

🏠 Play from Home

Enforces nickname format: nickname - real name (via modal).

Supports waitlist when LAN seats are full.

Admins must approve waitlisted users when a seat frees up.

Roles are automatically assigned/removed.

Persistent storage in lan-data.json.

Slash commands for admins.

⚙️ Setup
1. Install Node.js

Download and install Node.js LTS
.
Verify:

node -v

---

Deployment (Docker on Raspberry Pi + Home Assistant)

1) Create a .env file next to docker-compose.yml with at least:
	DISCORD_TOKEN=your_bot_token
	GUILD_ID=your_guild_id
	DATA_FILE=/app/lan-data.json
	# Optional
	TZ=Europe/Oslo

2) On your Raspberry Pi (with Docker + Compose plugin installed):
	- Make a folder, copy the repo contents (or git clone)
	- Ensure lan-data.json exists: echo {} > lan-data.json
	- Run: docker compose up -d

3) Auto-update:
	- A GitHub Actions workflow builds and pushes multi-arch images to GHCR on push to main.
	- The included watchtower service checks every 5 minutes and pulls updates automatically.

4) Auto-restart:
	- The lan-bot service is configured with restart: unless-stopped so it restarts on crash/boot.

5) Logs:
	- docker compose logs -f lan-bot

6) Home Assistant Core:
	- If running on the same host, Docker services run alongside HA Core without conflicts.
	- For supervised/add-on installs, consider using Portainer or the HA Docker integration to manage containers.

npm -v

2. Clone / unzip bot code

Put files in a folder, e.g.:

C:\lan-bot\

3. Install dependencies
cd lan-bot
npm install

4. Configure environment

Create a .env file in the bot folder:

DISCORD_TOKEN=your-bot-token-here
GUILD_ID=your-server-id
SIGNUP_CHANNEL_ID=channel-id-for-signup
ADMIN_CHANNEL_ID=channel-id-for-admin-alerts
DATA_FILE=./lan-data.json
SEAT_CAPACITY=48

5. Start the bot
npm start


(or node index.js if no start script)

🔄 Keeping it Running
Windows

Use nssm
 to install the bot as a service,
or create a Scheduled Task:

node C:\lan-bot\index.js

Linux / macOS

Install pm2:

npm install -g pm2
pm2 start index.js --name lan-bot
pm2 save
pm2 startup

🔧 Commands
User buttons

🎟 Join LAN (limited)

❓ Interested / Maybe

🏠 Play from Home

✏️ Set nick + real name

Admin slash commands

/postsignup [capacity] → Post signup panel in signup channel.

/setcapacity <n> → Change seat capacity.

/clearstatus @user → Remove user’s status.

/approve @user → Move waitlisted user into LAN seat.

/deny @user → Remove user from waitlist.

/statuslist → Show LAN/MAYBE/REMOTE counts + waitlist order.

/export → Export all signups to CSV.

📂 Data

All data is stored in lan-data.json.

Safe to back up / copy between machines.