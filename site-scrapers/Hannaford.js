const fs = require("fs");
const AWS = require("aws-sdk");
const sites = require("../data/sites.json");

const noAppointmentMatchString = "no locations with available appointments";

module.exports = async function GetAvailableAppointments(browser) {
    console.log("Hannaford starting.");
    const webData = await ScrapeWebsiteData(browser);
    console.log("Hannaford done.");
    return sites.Hannaford.locations.map((loc) => {
        const newLoc = { ...loc };
        const response = webData[loc.zip];
        return {
            name: `Hannaford (${loc.city})`,
            hasAvailability: response.indexOf(noAppointmentMatchString) == -1,
            extraData: response.length
                ? response.substring(1, response.length - 1)
                : response, //take out extra quotes
            signUpLink: sites.Hannaford.website,
            ...loc,
            timestamp: new Date(),
        };
    });
};

async function ScrapeWebsiteData(browser) {
    const page = await browser.newPage();
    await page.goto(sites.Hannaford.website);
    await page.solveRecaptchas().then(({ solved }) => {
        if (solved.length) {
            return page.waitForNavigation();
        } else {
            return;
        }
    });

    const results = {};

    for (const loc of [...new Set(sites.Hannaford.locations)]) {
        if (!results[loc.zip]) {
            await page.evaluate(
                () => (document.getElementById("zip-input").value = "")
            );
            await page.type("#zip-input", loc.zip);
            const [searchResponse, ...rest] = await Promise.all([
                Promise.race([
                    page.waitForResponse(
                        "https://hannafordsched.rxtouch.com/rbssched/program/covid19/Patient/CheckZipCode"
                    ),
                    page.waitForNavigation(),
                ]),
                page.click("#btnGo"),
            ]);
            const result = (await searchResponse.buffer()).toString();
            //if there's something available, log it with a unique name so we can check it out l8r g8r
            if (result.indexOf(noAppointmentMatchString) == -1) {
                let today = new Date();
                today =
                    today.getFullYear() +
                    "-" +
                    (today.getMonth() + 1) +
                    "-" +
                    today.getDate();
                const filename =
                    "hannaford-zip-" + loc.zip + "-date-" + today + ".png";
                await page.screenshot({ path: filename });
                await saveBodyHtml(page);
            }
            results[loc.zip] = result;
        }
    }

    return results;
}

async function writeFile(filename, data) {
    return new Promise((resolve, reject) => {
        fs.writeFile(filename, data, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function saveBodyHtml(page) {
    // It appears puppeteer does not a generic page.waitForNetworkIdle
    // so for now we just assume all XHR requests will complete within
    // a reasonable timeframe, for now 10s.
    await new Promise((resolve) => {
        setTimeout(function () {
            resolve("done waiting");
        }, 1000);
    });

    const body = await page.$("body");
    const html = await body.evaluate((node) => node.outerHTML);
    const timestamp =
        new Date().toISOString().substring(0, 16).replace(":", "") + "Z";
    const fileName = ["hannaford-", timestamp, ".html"].join("");
    await writeFile(fileName, html);
    await uploadFileToS3("debug", fileName);
    return fileName;
}

async function uploadFileToS3(bucketDir, fileName) {
    const fileContents = await new Promise((resolve, reject) => {
        fs.readFile(fileName, "utf-8", async (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });

    const s3 = new AWS.S3({
        accessKeyId: process.env.AWSACCESSKEYID,
        secretAccessKey: process.env.AWSSECRETACCESSKEY,
    });

    const s3Key = [bucketDir, fileName].join("/");
    const params = {
        Bucket: process.env.AWSS3BUCKETNAME,
        Key: s3Key,
        Body: fileContents,
    };

    await new Promise((resolve, reject) => {
        s3.upload(params, function (err, data) {
            if (err) {
                reject(err);
            }
            console.log(`File uploaded successfully. ${data.Location}`);
            resolve(data);
        });
    });
}
