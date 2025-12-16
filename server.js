const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
require('dotenv').config();
const crypto = require('crypto');

const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const uploadCloudMiddleware = require('./middlewares/uploadCloud.middleware')

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Kết nối MongoDB
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('MongoDB connected to product-blockchain'))
  .catch(err => console.error('MongoDB connection error:', err));

// Models
const productSchema = new mongoose.Schema(
  {
    productId: { type: Number, unique: true },

    name: { type: String, required: true },

    thumbnail: { type: String, default: '' },

    status: {
      type: String,
      enum: ['active', 'inactive'], 
      default: 'active',             
      required: true,
    },

    quantity: { type: Number, default: 0 },

    price: { type: Number, required: true },
  },
  { collection: 'product', timestamps: true }
);

const Product = mongoose.model('ProductModel', productSchema);


const logSchema = new mongoose.Schema({
  type: String,
  productId: Number,
  amount: Number,
  timestamp: Date,
  ipfsHash: String
});
const Log = mongoose.model('Log', logSchema);

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_API = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

// ================= BLOCKCHAIN =================

class Block {
  constructor(index, timestamp, data, previousHash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data; // { type, productId, amount, ipfsHash }
    this.previousHash = previousHash;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash('sha256')
      .update(
        this.index +
        this.previousHash +
        this.timestamp +
        JSON.stringify(this.data)
      )
      .digest('hex');
  }
}

class Blockchain {
  constructor() {
    this.chain = [this.createGenesisBlock()];
  }

  createGenesisBlock() {
    return new Block(0, new Date().toISOString(), 'Genesis Block', '0');
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(data) {
    const newBlock = new Block(
      this.chain.length,
      new Date().toISOString(),
      data,
      this.getLatestBlock().hash
    );
    this.chain.push(newBlock);
    return newBlock;
  }

  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const previous = this.chain[i - 1];

      if (current.hash !== current.calculateHash()) return false;
      if (current.previousHash !== previous.hash) return false;
    }
    return true;
  }
}

// Blockchain instance
const warehouseBlockchain = new Blockchain();

// Thêm sản phẩm
app.post('/add-product', async (req, res) => {
  try {
    console.log('Add product body:', req.body);
    const { name, quantity, price, thumbnail, status } = req.body;
    const customId = Date.now();
    const product = new Product({ productId: customId, name, quantity: parseInt(quantity), price: parseFloat(price), thumbnail: thumbnail, status: status });
    await product.save();
    console.log('Added product ID:', customId);
    res.json({ success: true, product });
  } catch (error) {
    console.error('Add product error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Chỉnh sửa trạng thái
app.patch('/product/change-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log("id:", id);
    console.log('Edit status product body:', req.body);
    await Product.updateOne(
      { _id: id },
      {
        status: req.body.status
      }
    )
    res.json({ success: true, message: "Cập nhật trạng thái thành công" });
  } catch (error) {
    console.error('Add product error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Nhập kho (sửa Pinata upload bằng JSON)
app.post('/import', async (req, res) => {
  try {
    console.log('Import body:', req.body);
    const { productId, amount } = req.body;
    const product = await Product.findOne({ productId: parseInt(productId) });
    if (!product) {
      console.log('Product not found for ID:', productId);
      return res.status(404).json({ error: 'Product not found with ID: ' + productId });
    }
    product.quantity += parseInt(amount);
    await product.save();

    const log = new Log({ type: 'import', productId: parseInt(productId), amount: parseInt(amount), timestamp: new Date() });
    // Upload JSON to Pinata (raw JSON)
    const pinataBody = {
      pinataContent: log.toObject(),
      pinataMetadata: { name: `Log-import-${log.timestamp}` }
    };
    console.log('Uploading to Pinata:', pinataBody);
    const response = await fetch(PINATA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pinataBody)
    });
    const result = await response.json();
    console.log('Pinata result:', result);
    if (result.IpfsHash) {
      log.ipfsHash = result.IpfsHash;
      await log.save();

      // === ADD BLOCK TO BLOCKCHAIN ===
      warehouseBlockchain.addBlock({
        type: 'import',
        productId: parseInt(productId),
        amount: parseInt(amount),
        ipfsHash: result.IpfsHash
      });

      res.json({
        success: true,
        log,
        ipfsLink: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`
      });
    } else {
      console.log('Pinata failed, saving log without IPFS');
      await log.save();  // Lưu log ngay cả khi Pinata fail
      res.json({ success: true, log, ipfsLink: null, warning: 'IPFS upload failed, log saved locally' });
    }
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Xuất kho (tương tự)
app.post('/export', async (req, res) => {
  try {
    console.log('Export body:', req.body);
    const { productId, amount } = req.body;
    const product = await Product.findOne({ productId: parseInt(productId) });
    if (!product) {
      console.log('Product not found for ID:', productId);
      return res.status(404).json({ error: 'Product not found with ID: ' + productId });
    }
    if (product.quantity < parseInt(amount)) return res.status(400).json({ error: 'Insufficient stock' });
    product.quantity -= parseInt(amount);
    await product.save();

    const log = new Log({ type: 'export', productId: parseInt(productId), amount: parseInt(amount), timestamp: new Date() });
    const pinataBody = {
      pinataContent: log.toObject(),
      pinataMetadata: { name: `Log-export-${log.timestamp}` }
    };
    console.log('Uploading to Pinata:', pinataBody);
    const response = await fetch(PINATA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pinataBody)
    });
    const result = await response.json();
    console.log('Pinata result:', result);
    if (result.IpfsHash) {
      log.ipfsHash = result.IpfsHash;
      await log.save();

      // === ADD BLOCK TO BLOCKCHAIN ===
      warehouseBlockchain.addBlock({
        type: 'export',
        productId: parseInt(productId),
        amount: parseInt(amount),
        ipfsHash: result.IpfsHash
      });

      res.json({
        success: true,
        log,
        ipfsLink: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`
      });
    } else {
      console.log('Pinata failed, saving log without IPFS');
      await log.save();
      res.json({ success: true, log, ipfsLink: null, warning: 'IPFS upload failed, log saved locally' });
    }
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Xem kho
app.get('/warehouse', async (req, res) => {
  try {
    const products = await Product.find().sort({ productId: -1 });
    console.log('Warehouse query:', products.length, 'products');
    res.json(products);
  } catch (error) {
    console.error('Warehouse error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Xem sản phẩm hoạt động trong kho
app.get('/warehouse/active', async (req, res) => {
  try {
    const products = await Product.find({ status: "active" }).sort({ productId: -1 });
    res.json(products);
  } catch (error) {
    console.error('Warehouse error:', error);
    res.status(500).json({ error: error.message });
  }
});

// View blockchain
app.get('/blockchain', (req, res) => {
  res.json({
    valid: warehouseBlockchain.isChainValid(),
    length: warehouseBlockchain.chain.length,
    chain: warehouseBlockchain.chain
  });
});

// Xem logs (lấy tất cả, không filter)
app.get('/logs', async (req, res) => {
  try {
    const logs = await Log.find().sort({ timestamp: -1 });
    console.log('Logs query:', logs.length, 'logs');
    res.json(logs);
  } catch (error) {
    console.error('Logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload Image
app.post('/upload-cloud-image', upload.array('upload', 10), uploadCloudMiddleware.upload, async (req, res) => {
  try {
    if (req.body.urls) {
      if (req.body.urls.length === 1) {
        res.json({ url: req.body.urls[0] }); 
      } else {
        res.json({ urls: req.body.urls }); 
      }
    } else {
      res.json({ urls: [] }); 
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 5000, () => console.log('Backend on port 5000'));