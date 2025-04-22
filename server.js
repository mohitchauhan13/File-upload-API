// // server.js
// const express = require("express");
// const fs = require("fs");
// const path = require("path");
// const cors = require("cors");

// const app = express();
// app.use(cors());
// app.use(express.json());

// const UPLOAD_DIR = path.join(__dirname, "uploads");
// if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// // Receive raw chunk
// app.post("/upload", async (req, res) => {
//   const fileId = req.headers["x-file-id"];
//   const chunkIndex = req.headers["x-chunk-index"];
//   console.log("chuckIndex", chunkIndex, "FileID", fileId);
//   if (!fileId || chunkIndex === undefined) {
//     return res.status(400).json({ error: "Missing headers" });
//   }

//   const chunkDir = path.join(UPLOAD_DIR, fileId);
//   if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir);

//   const chunkPath = path.join(chunkDir, chunkIndex);
//   console.log("chunkPath", chunkPath);

//   const writeStream = fs.createWriteStream(chunkPath);
//   console.log("writeStream", writeStream);

//   req.pipe(writeStream);

//   writeStream.on("finish", () => {
//     console.log(`Chunk ${chunkIndex} saved`);
//     res.status(200).json({ message: `Chunk ${chunkIndex} received` });
//   });

//   writeStream.on("error", (err) => {
//     console.error("Write error:", err);
//     res.status(500).json({ error: "Failed to save chunk" });
//   });
// });

// // Check uploaded chunks (resumable)
// app.get("/status", (req, res) => {
//   const { fileId } = req.query;
//   const chunkDir = path.join(UPLOAD_DIR, fileId);
//   let uploadedChunks = [];
//   if (fs.existsSync(chunkDir)) {
//     uploadedChunks = fs.readdirSync(chunkDir);
//   }
//   res.json({ uploadedChunks });
// });

// // Merge chunks
// app.post("/merge", (req, res) => {
//   const { fileId, fileName, totalChunks } = req.body;

//   const chunkDir = path.join(UPLOAD_DIR, fileId);
//   const finalPath = path.join(UPLOAD_DIR, fileName);

//   // Check all chunks exist
//   for (let i = 0; i < totalChunks; i++) {
//     const chunkPath = path.join(chunkDir, i.toString());
//     if (!fs.existsSync(chunkPath)) {
//       return res.status(400).json({ error: `Missing chunk ${i}` });
//     }
//   }

//   const writeStream = fs.createWriteStream(finalPath);

//   const mergeChunks = async () => {
//     for (let i = 0; i < totalChunks; i++) {
//       const chunkPath = path.join(chunkDir, i.toString());
//       const chunk = fs.readFileSync(chunkPath);
//       writeStream.write(chunk);
//     }
//     writeStream.end();
//     fs.rmSync(chunkDir, { recursive: true, force: true });
//     res.json({ message: "Merged successfully" });
//   };

//   mergeChunks();
// });

// app.listen(4000, () => {
//   console.log("Server running at http://localhost:4000");
// });

require("dotenv").config();
const express = require("express");
const AWS = require("aws-sdk");
const cors = require("cors");
const { PassThrough } = require("stream");

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;

app.post("/upload", async (req, res) => {
  const fileId = req.headers["x-file-id"];
  const chunkIndex = req.headers["x-chunk-index"];
  if (!fileId || chunkIndex === undefined) {
    return res.status(400).json({ error: "Missing headers" });
  }

  const key = `${fileId}/${chunkIndex}`;
  const pass = new PassThrough();

  const uploadParams = {
    Bucket: BUCKET,
    Key: key,
    Body: pass,
  };

  s3.upload(uploadParams, (err, data) => {
    if (err) return res.status(500).json({ error: "Upload failed" });
    res.status(200).json({ message: `Chunk ${chunkIndex} uploaded` });
  });

  req.pipe(pass);
});

app.get("/status", async (req, res) => {
  const { fileId } = req.query;
  const listParams = {
    Bucket: BUCKET,
    Prefix: `${fileId}/`,
  };

  try {
    const data = await s3.listObjectsV2(listParams).promise();
    const uploadedChunks = data.Contents.map((obj) => obj.Key.split("/")[1]);
    res.json({ uploadedChunks });
  } catch {
    res.status(500).json({ error: "Failed to list chunks" });
  }
});

app.post("/merge", async (req, res) => {
  const { fileId, fileName, totalChunks } = req.body;
  const mergedKey = `merged/${fileName}`;

  try {
    let mergedBuffer = Buffer.alloc(0);
    for (let i = 0; i < totalChunks; i++) {
      const part = await s3
        .getObject({ Bucket: BUCKET, Key: `${fileId}/${i}` })
        .promise();
      mergedBuffer = Buffer.concat([mergedBuffer, part.Body]);
    }

    await s3
      .putObject({
        Bucket: BUCKET,
        Key: mergedKey,
        Body: mergedBuffer,
      })
      .promise();

    // Optional: delete chunked parts after merge
    const listData = await s3
      .listObjectsV2({ Bucket: BUCKET, Prefix: `${fileId}/` })
      .promise();
    const objectsToDelete = listData.Contents.map((obj) => ({ Key: obj.Key }));
    if (objectsToDelete.length)
      await s3
        .deleteObjects({ Bucket: BUCKET, Delete: { Objects: objectsToDelete } })
        .promise();

    res.json({
      message: "Merged",
      fileUrl: `https://${BUCKET}.s3.amazonaws.com/${mergedKey}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Merge failed" });
  }
});

app.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});
