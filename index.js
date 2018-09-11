const puppeteer = require('puppeteer');
const mysql = require('mysql');

process.setMaxListeners(Infinity);

process.on('uncaughtException', (err) => {
    console.log(err);
    process.exit(1);
});

process.on("unhandledRejection", (reason, p) => {
    console.error("Unhandled Rejection at: Promise", p, "reason:", reason);
    process.exit(1);
});

const waitOptions = {waitUntil: 'networkidle2', timeout: 120000};

const denyMediaRequests = (request) => {
    if (['image', 'stylesheet', 'font', 'script'].indexOf(request.resourceType()) !== -1) {
        request.abort();
    } else {
        request.continue();
    }
};

const login = async (browser) => {
    console.log("logging in");

    const page = await browser.newPage();
    await page.goto('https://event.steptember.nl/login', waitOptions);

    await sleep(150);
    const pageWait = page.waitForNavigation(waitOptions);
    await page.evaluate((username, password) => {
        document.querySelector('.signinForm input[name="userName"]').value = username;
        document.querySelector('.signinForm input[name="password"]').value = password;
        document.querySelector(".signinForm form").submit.click();
    }, process.env.STEPTEMBER_USERNAME, process.env.STEPTEMBER_PASSWORD);
    await pageWait;

    await page.goto('about:blank'); // free up memory
    await page.close();

    console.log("logged in");
};

const createRecord = async (browser, id) => {
    console.log(`querying ${id}`);

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    await page.on('request', denyMediaRequests);
    await page.goto(`https://event.steptember.nl/donate/onbehalfof?id=${id}`, waitOptions);

    await page.evaluate(() => {
        window.calculateMeters = (string) => {
            const components = string.split(" ");
            let distance = parseInt(components[0], 10);
            if (components[1] === "km")
                distance *= 1000;
            return distance;
        };
    });

    const response = await page.evaluate((id) => ({
        caloriesBurnt: parseInt(document.querySelector('h3.caloriesBurnt').textContent.replace(".", ""), 10),
        steps: parseInt(document.querySelector('h3.profileStepsCount').textContent.replace(",", "").replace(".", ""), 10),
        distance: calculateMeters(document.querySelector('h3.distanceTravelled').textContent),
        participantId: id
    }), id);

    await page.goto('about:blank'); // free up memory
    await page.close();
    return response;
};

const queryTeams = async (browser) => {
    console.log("querying teams");

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    await page.on('request', denyMediaRequests);
    await page.goto('https://event.steptember.nl/team/leaderboardsteps?category=org', waitOptions);

    const response = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.listLeaderboardTeam li')).map(team => ({
                name: team.querySelector('div[class="name"]').textContent,
                members: Array.from(team.querySelectorAll('p[class="teamMembers"] a')).map(member => ({
                    name: member.textContent,
                    id: member.href.split("=")[1],
                    team: team.querySelector('div[class="name"]').textContent
                }))
            })
        ));

    await page.goto('about:blank'); // free up memory
    await page.close();
    return response;
};

const getParticipantsFromTeams = (teams) =>
    teams.reduce((acc, team) => acc.concat(team.members), []);

const connect = () =>
    new Promise((resolve, reject) => {
        const con = mysql.createConnection({
            host: process.env.MYSQL_ADDON_HOST,
            user: process.env.MYSQL_ADDON_USER,
            password: process.env.MYSQL_ADDON_PASSWORD,
            database: process.env.MYSQL_ADDON_DB,
            port: process.env.MYSQL_ADDON_PORT
        });
        con.connect((err) => {
            if (err) reject(err);
            console.log("connected to mysql");
            resolve(con);
        });
    });

const createTables = (query) =>
    Promise.all([
        query("CREATE TABLE IF NOT EXISTS `teams` (name VARCHAR(255), id INT AUTO_INCREMENT PRIMARY KEY)"),
        query("CREATE TABLE IF NOT EXISTS `participants` (name VARCHAR(255), id VARCHAR(255) PRIMARY KEY, team_id INT, CONSTRAINT FK_Team FOREIGN KEY (team_id) REFERENCES teams(id))"),
        query("CREATE TABLE IF NOT EXISTS `records` (id INT AUTO_INCREMENT PRIMARY KEY, participant_id VARCHAR(255), time DATETIME, calories_burnt INT, steps INT, distance INT, CONSTRAINT FK_Participant FOREIGN KEY (participant_id) REFERENCES participants(id))")
    ]);

const queryMySQL = (con) => (sql, data = []) =>
    new Promise((resolve, reject) =>
        con.query(sql, data, (err, result) => {
            if (err) reject(err);
            resolve(result);
        }));

const insertTeamIntoMySQL = (query, team) =>
    query("SELECT * FROM `teams` WHERE `name` = ?", [
        team.name
    ]).then((response) => {
        if (!response || response.length === 0) {
            query("INSERT INTO `teams` (`name`) VALUES (?)", [
                team.name
            ]);
        }
    });

const insertTeamsIntoMySQL = (query, teams = []) =>
    teams.map((team) => insertTeamIntoMySQL(query, team));

const findTeamIdByName = (query, teamName) =>
    query("SELECT `id` FROM `teams` WHERE `name` = ?", [
        teamName
    ]).then((response) => {
        if (response && response.length)
            return response[0];
        else
            throw teamNotFoundError;
    });

const insertParticipantIntoMySQL = (query, participant) =>
    query("SELECT * FROM `participants` WHERE `id` = ?", [
        participant.id
    ]).then((response) => {
        if (!response || response.length === 0) {
            findTeamIdByName(query, participant.team).then((response) => {
                query("INSERT INTO `participants` (`name`, `id`, `team_id`) VALUES (?, ?, ?)", [
                    participant.name,
                    participant.id,
                    response.id
                ]);
            });
        }
    });

const insertParticipantsIntoMySQL = (query, participants = []) =>
    participants.map((participant) => insertParticipantIntoMySQL(query, participant));

const insertRecordIntoMySQL = (query, record) =>
    query("INSERT INTO `records` (`participant_id`, `time`, `calories_burnt`, `steps`, `distance`) VALUES (?, now(), ?, ?, ?)", [
        record.participantId,
        record.caloriesBurnt,
        record.steps,
        record.distance
    ]);

const insertRecordsIntoMySQL = async (query, records = []) =>
    await Promise.all(records.map(async (record) => await insertRecordIntoMySQL(query, record)));

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

const fifteenMinutes = 15 * 60 * 1000;

connect().then((async (con) => {
    const query = queryMySQL(con);
    await createTables(query);

    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    await login(browser);
    const teams = await queryTeams(browser);
    await insertTeamsIntoMySQL(query, teams);

    await sleep(500);

    const participants = getParticipantsFromTeams(teams);
    await insertParticipantsIntoMySQL(query, participants);

    await sleep(500);

    while (true) {
        console.log("querying records...");

        // synchronously query records in order to not max out memory limits
        let membersScores = [];
        for (let i = 0; i < participants.length; i++) {
            const score = await createRecord(browser, participants[i].id);
            membersScores.push(score);
            await sleep(50);
        }

        console.log("saving records...");

        await insertRecordsIntoMySQL(query, membersScores);

        console.log("querying done, repeating in 15 minutes...");

        await sleep(fifteenMinutes);
    }

    await browser.close();
}));