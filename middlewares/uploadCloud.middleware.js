const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET
});

module.exports.upload = (req, _, next) => {
  if (req.files && req.files.length > 0) { 
    const uploadPromises = req.files.map(file => {
      return new Promise((resolve, reject) => {
        let stream = cloudinary.uploader.upload_stream(
          { folder: 'personal-one' },
          (error, result) => {
            if (result) resolve(result.secure_url);
            else reject(error);
          }
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });
    });

    Promise.all(uploadPromises)
      .then(urls => {
        console.log('Upload success:', urls); 
        req.body.urls = urls; 
        next();
      })
      .catch(error => {
        console.error('Upload error:', error);
        next(error);
      });
  } else {
    next();
  }
};