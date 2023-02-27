require("dotenv").config();
const fetch = require('isomorphic-fetch');
const HttpsProxyAgent = require("https-proxy-agent");
const {
    TwitterApi,
    EDirectMessageEventTypeV1
} = require("twitter-api-v2");
const fs = require('fs');
const FormData = require('form-data');

const dbfile = './db.json';
if (!fs.existsSync(dbfile)) {
    fs.writeFileSync(dbfile, JSON.stringify({
        saved: []
    }));
}

const httpAgent = process.env.HTTP_PROXY ? new HttpsProxyAgent(process.env.HTTP_PROXY) : undefined;

const client = new TwitterApi({
    appKey: process.env.TWITTER_CONSUMER_KEY,
    appSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET
}, {
    httpAgent
});

async function uploadMedia(media_url, filename) {
    const _media = await fetch(media_url, {
        agent: httpAgent
    });
    const media = await _media.buffer();
    const formData = new FormData();
    formData.append('file', media, {
        filename: filename,
    });
    const _result = await fetch(`${MEMOS_HOST}/api/resource/blob?openId=${process.env.MEMOS_OPEN_ID}`, {
        method: 'post',
        body: formData,
        agent: httpAgent
    })
    const result = await _result.json();
    if (result.error) {
        throw new Error(result.error);
    } else {
        return result;
    }
}

async function newMemos(memos, resourceList) {
    const _result = await fetch(`${MEMOS_HOST}/api/memo?openId=${process.env.MEMOS_OPEN_ID}`, {
        method: 'post',
        body: JSON.stringify({
            content: memos,
            visibility: '',
            resourceIdList: resourceList
        }),
        headers: {
            'Content-Type': 'application/json'
        },
        agent: httpAgent
    });
    const result = await _result.json();
    if (result.error) {
        throw new Error(result.error);
    } else {
        return result;
    }
}

async function getTweet(tweet_id) {
    const status = await client.v1.singleTweet(tweet_id, {
        include_entities: true,
    });
    const status_entities = status.entities;
    const status_urls = status_entities.urls;
    let status_text = status.full_text;
    if (status_urls.length) {
        status_urls.forEach((url) => {
            status_text = status_text.replace(url.url, url.expanded_url);
        })
        status.extended_entities?.media?.forEach(media => {
            status_text = status_text.replace(media.url, '');
        })
    };
    const tweet_date = new Date(status.created_at).toLocaleString();
    const tweet = {
        id: status.id_str,
        text: status_text.replace(/#([^\s#]+)/g, '*$1*').trim(),
        user_name: status.user.name,
        user_screen_name: status.user.screen_name,
        date: tweet_date,
        media: status.extended_entities?.media?.map((media) => {
            return {
                url: media.media_url_https,
                video_url: media.video_info?.variants?.find(variant => variant.content_type === 'video/mp4')?.url,
                type: media.type,
                width: media.sizes.large.w,
                height: media.sizes.large.h,
            }
        }),
    }
    return tweet;
}

(async (start) => {
    try {
        const db = fs.readFileSync('db.json', 'utf8');
        const dbJson = JSON.parse(db);

        const loggedUser = await client.v1.verifyCredentials();
        const id = loggedUser.id;

        console.log('bot info:', {
            name: loggedUser.name,
            screen_name: loggedUser.screen_name,
        });

        const mentionTimeline = await client.v1.mentionTimeline({ trim_user: true });
        const fetchedTweets = mentionTimeline.tweets;
        const memos_tweets = fetchedTweets.filter(tweet => {
            return tweet.full_text.trim().endsWith(`@${loggedUser.screen_name} memo`);
        });
        for (let index = 0; index < memos_tweets.length; index++) {
            const tweet_id = memos_tweets[index].in_reply_to_status_id_str;
            const tweet = await getTweet(tweet_id);
            memos_tweets[index] = tweet;
        }

        const eventsPaginator = await client.v1.listDmEvents();
        const dm_tweets = [];
        for await (const event of eventsPaginator) {
            if (event.type === EDirectMessageEventTypeV1.Create && event[EDirectMessageEventTypeV1.Create].sender_id !== id) {
                const message = event[EDirectMessageEventTypeV1.Create];
                const message_data = message.message_data;
                const entities = message_data.entities;
                const urls = entities.urls;
                if (!urls.length) {
                    continue;
                }
                const url = urls[0];
                const expanded_url = url.expanded_url;
                const status_id = expanded_url.split('/').pop();
                // check is tweet id
                if (!status_id.match(/^\d+$/)) {
                    continue;
                }
        
                const tweet = await getTweet(status_id);
                dm_tweets.push(tweet);
            }
        }

        const tweets = [...memos_tweets, ...dm_tweets];
        console.log('tweets:', tweets);
        for (let index = 0; index < tweets.length; index++) {
            const tweet = tweets[index];
            const saved = dbJson.saved.find(saved => saved.tweet.id === tweet.id);
            if (saved) {
                continue;
            }
            
            const resourceList = [];
            if (!tweet.media) {
                tweet.media = [];
            }
            for (let index = 0; index < tweet.media.length; index++) {
                const media = tweet.media[index];
                const media_url = media.video_url || media.url;
                const media_ext = new URL(media_url).pathname.split('.').pop();
                const result = await uploadMedia(media_url, `${tweet.id}_${index+1}.${media_ext}`);
                if (result.data.id) {
                    resourceList.push(result.data.id);
                }
                console.log('upload media success:', result.data.id, media_url);
            }
            const tweet_url = `https://twitter.com/${tweet.user_screen_name}/status/${tweet.id}`;
            const tweet_user_url = `https://twitter.com/${tweet.user_screen_name}`;
            const markdown = `${tweet.text}\n\n---\n${tweet_url}\n[@${tweet.user_name}](${tweet_user_url})\n${tweet.date}\n\n#tweet`;
            const newMemosResult = await newMemos(markdown, resourceList);
            dbJson.saved.push({
                resourceList,
                tweet,
            });
            fs.writeFileSync('db.json', JSON.stringify(dbJson));
            console.log('new memos success:', newMemosResult?.id);
        }
    } catch (e) {
        // Display the error and quit
        console.error(e.message);
        // process.exit(1);
    }
})();
