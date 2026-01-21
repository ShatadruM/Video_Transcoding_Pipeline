require('dotenv').config();
const { Consumer } = require('sqs-consumer');
const { SQSClient, DeleteMessageCommand } = require('@aws-sdk/client-sqs'); // Import Delete Command
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream/promises');

// --- CONFIGURATION ---
const REGION = process.env.AWS_REGION || 'ap-south-1'; // Ensure this matches your bucket/queue
const SQS_URL = process.env.SQS_QUEUE_URL;
const INPUT_BUCKET = process.env.INPUT_BUCKET;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// --- AWS CLIENTS ---
const s3Client = new S3Client({ 
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const sqsClient = new SQSClient({
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

/**
 * --- WORKER INITIALIZATION ---
 */
const app = Consumer.create({
    queueUrl: SQS_URL,
    sqs: sqsClient,
    batchSize: 1,
    shouldDeleteMessages: false, // <--- CRITICAL: We turn off auto-delete
    
    handleMessage: async (message) => {
        let body;
        try {
            body = JSON.parse(message.Body);
        } catch (error) {
            console.error('❌ Malformed JSON. Deleting manually.');
            await deleteMessage(message.ReceiptHandle);
            return;
        }

        // Validate S3 Event
        if (!body.Records) {
            console.log('⚠️  Not an S3 Event. Deleting manually.');
            await deleteMessage(message.ReceiptHandle);
            return;
        }

        const s3Record = body.Records[0].s3;
        const bucketName = s3Record.bucket.name;
        const objectKey = decodeURIComponent(s3Record.object.key.replace(/\+/g, ' '));

        if (bucketName !== INPUT_BUCKET) {
            console.log(`⚠️  Skipping event from unknown bucket: ${bucketName}`);
            await deleteMessage(message.ReceiptHandle);
            return;
        }

        console.log(`\n📦 Job Received: ${objectKey}`);

        try {
            // 1. Process the Video
            await processVideoPipeline(objectKey);
            
            // 2. MANUAL DELETE (Only runs if processing succeeds)
            console.log('🗑️  Deleting message from Queue...');
            await deleteMessage(message.ReceiptHandle);
            console.log('✅ Message Deleted Successfully!');

        } catch (error) {
            console.error('❌ Pipeline Failed. Keeping message in queue for retry.');
            console.error(error.message);
            // We do NOT delete here, so SQS will retry after VisibilityTimeout
        }
    }
});

app.on('error', (err) => console.error('❌ SQS Error:', err.message));
app.on('processing_error', (err) => console.error('❌ Processing Error:', err.message));

app.start();
console.log('🚀 Transcoder Worker (Manual Delete Mode) is running...');


/**
 * --- HELPER: Manual Delete ---
 */
async function deleteMessage(receiptHandle) {
    try {
        const command = new DeleteMessageCommand({
            QueueUrl: SQS_URL,
            ReceiptHandle: receiptHandle
        });
        await sqsClient.send(command);
    } catch (err) {
        console.error(`❌ FAILED to delete message from SQS: ${err.message}`);
        // This log is what we are looking for. 
        // If this prints, we know exactly why the loop is happening.
        throw err; 
    }
}

/**
 * --- TRANSCODING PIPELINE ---
 */
async function processVideoPipeline(objectKey) {
    const runId = Date.now();
    const fileName = path.basename(objectKey);
    const fileBaseName = fileName.split('.')[0];
    
    const workDir = path.resolve(`./tmp/${runId}`);
    const inputPath = path.join(workDir, fileName);
    const output480 = path.join(workDir, `${fileBaseName}-480.mp4`);
    const output360 = path.join(workDir, `${fileBaseName}-360.mp4`);

    try {
        await fs.ensureDir(workDir);

        // Step 1: Download
        console.log(`   ⬇️  Downloading...`);
        const command = new GetObjectCommand({ Bucket: INPUT_BUCKET, Key: objectKey });
        const response = await s3Client.send(command);
        await pipeline(response.Body, fs.createWriteStream(inputPath));

        // Step 2: Transcode
        console.log(`   🎬 Transcoding...`);
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .output(output480)
                .videoCodec('libx264')
                .audioCodec('aac')
                .size('854x480')
                .output(output360)
                .videoCodec('libx264')
                .audioCodec('aac')
                .size('640x360')
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .run();
        });

        // Step 3: Upload
        console.log(`   ⬆️  Uploading...`);
        const filesToUpload = [output480, output360];
        const uploadPromises = filesToUpload.map(filePath => {
            const fileName = path.basename(filePath);
            const fileStream = fs.createReadStream(filePath);
            const upload = new Upload({
                client: s3Client,
                params: {
                    Bucket: OUTPUT_BUCKET,
                    Key: `transcoded/${fileName}`,
                    Body: fileStream,
                    ContentType: 'video/mp4'
                }
            });
            return upload.done();
        });

        await Promise.all(uploadPromises);
        console.log(`✅ Upload Complete!`);

    } finally {
        await fs.remove(workDir);
    }
}