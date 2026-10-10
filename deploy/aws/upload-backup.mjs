import { createReadStream, statSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const [file, key] = process.argv.slice(2);
if (!file || !key?.startsWith('backups/')) throw new Error('Expected a file and backups/ object key');
await new S3Client({ region: process.env.AWS_REGION }).send(new PutObjectCommand({
  Bucket: process.env.S3_BUCKET, Key: key, Body: createReadStream(file),
  ContentLength: statSync(file).size, ContentType: 'application/gzip'
}));
console.log('Database backup uploaded.');
