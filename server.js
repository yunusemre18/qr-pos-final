require("dotenv").config();
const express = require("express");
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require("mongoose");
const basicAuth = require("express-basic-auth");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");

const Product = require("./models/Product");
const Table = require("./models/Table");
const Order = require("./models/Order");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO = process.env.MONGO_URI || "mongodb://localhost:27017/qrdb_en";

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    }
});


// Auth setup
const USERS = {
    [process.env.ADMIN_USER]: process.env.ADMIN_PASS,
    [process.env.WAITER_USER]: process.env.WAITER_PASS,
    [process.env.KITCHEN_USER]: process.env.KITCHEN_PASS,
};

const basicAuthMiddleware = basicAuth({
    users: USERS,
    challenge: true,
    unauthorizedResponse: () => 'Unauthorized Access: You do not have permission to access this panel.',
});

const authByRole = (allowedUsers) => (req, res, next) => {
    const user = req.auth.user;

    if (user === process.env.ADMIN_USER) {
        return next();
    }

    if (allowedUsers.includes(user)) {
        return next();
    }

    res.status(401).send('Your access to this panel is restricted.');
};

const AdminAuth = authByRole([process.env.ADMIN_USER]);
const WaiterAuth = authByRole([process.env.WAITER_USER]);
const KitchenAuth = authByRole([process.env.KITCHEN_USER, process.env.WAITER_USER]);

// File upload cleanup helper
function cleanupUploadedFile(req) {
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
}

// Multer config
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, "public", "images");
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const safeName = req.body.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const ext = path.extname(file.originalname);
        const newFileName = `${safeName}${ext}`;
        req.body.generatedFileName = `/images/${newFileName}`;
        cb(null, newFileName);
    }
});

const fileFilter = function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(null, false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: fileFilter
});


// Panel page routes
app.get("/admin.html", basicAuthMiddleware, AdminAuth, (req, res) =>
    res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.get("/waiter.html", basicAuthMiddleware, WaiterAuth, (req, res) =>
    res.sendFile(path.join(__dirname, "public", "waiter.html"))
);

app.get("/kitchen.html", basicAuthMiddleware, KitchenAuth, (req, res) =>
    res.sendFile(path.join(__dirname, "public", "kitchen.html"))
);

app.get("/", (req, res) => {
    const { table } = req.query;
    if (!table) return res.status(400).send("Table number is not specified");
    res.sendFile(path.join(__dirname, "public", "customer.html"));
});

app.use(express.static(path.join(__dirname, "public")));

mongoose
    .connect(MONGO)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection error:", err));



// Product routes
app.post("/api/products", basicAuthMiddleware, AdminAuth, upload.single('photoFile'), async (req, res) => {
    try {
        const { name, price, category, mainCategory, description, prepLocation, optionsJSON, generatedFileName } = req.body;

        if (!name || price === undefined || !mainCategory || !prepLocation) {
            cleanupUploadedFile(req);
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }

        let parsedOptions = [];
        try {
            if (optionsJSON) parsedOptions = JSON.parse(optionsJSON);
        } catch (err) {
            cleanupUploadedFile(req);
            return res.status(400).json({ success: false, message: "Invalid JSON format." });
        }

        const newProduct = new Product({
            name,
            photo: req.file ? generatedFileName : '',
            price: Number(price),
            category: category || '',
            mainCategory,
            description: description || '',
            orderNo: Date.now(),
            options: parsedOptions,
            prepLocation
        });

        const savedProduct = await newProduct.save();
        io.emit('update_orders');
        res.status(201).json({ success: true, product: savedProduct });

    } catch (err) {
        cleanupUploadedFile(req);
        res.status(500).json({ success: false, message: "Server error occurred." });
    }
});

app.get("/api/products", async (req, res) => {
    try {
        const products = await Product.find().lean().sort({ orderNo: 1 });
        res.json(products);
    } catch (err) {
        res.status(500).json({ message: "Could not retrieve products" });
    }
});

app.post("/api/reorder-products", basicAuthMiddleware, AdminAuth, async (req, res) => {
    try {
        const { updates } = req.body;
        for (let u of updates) {
            await Product.findByIdAndUpdate(u.id, { orderNo: u.orderNo });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Reorder failed." });
    }
});

// Table routes
app.post("/api/table-connect", async (req, res) => {
    try {
        const tableNo = Number(req.body.tableNo);
        await Table.findOneAndUpdate(
            { tableNo },
            { $set: { isConnected: true } },
            { upsert: true, new: true }
        );
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get("/api/tables", async (req, res) => {
    try {
        const tables = await Table.find().lean();
        res.json(tables);
    } catch (err) {
        res.status(500).json({ message: "Could not retrieve tables" });
    }
});

// Order routes
app.post("/api/orders", async (req, res) => {
    try {
        const { productId, quantity, note, addedBy, price } = req.body;
        const tableNo = Number(req.body.tableNo);
        if (!tableNo || !productId || !quantity || price === undefined) {
            return res.status(400).json({ message: "Missing parameter" });
        }

        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ message: "Product not found" });

        const itemPrice = Number(price) || product.price;
        const initialStatus = (product.prepLocation === 'Service') ? 'Ready' : 'Received';

        const orders = Array.from({ length: quantity }, () => ({
            tableNo,
            productId,
            quantity: 1,
            price: itemPrice,
            note: note || "",
            addedBy: addedBy || 'Customer',
            status: initialStatus
        }));

        await Order.insertMany(orders);
        product.salesCount = (product.salesCount || 0) + quantity;
        await product.save();

        await Table.findOneAndUpdate({ tableNo }, { $inc: { total: itemPrice * quantity } }, { upsert: true });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Order error" });
    }
});

app.post("/api/call-waiter", async (req, res) => {
    try {
        const tableNo = Number(req.body.tableNo);
        await Table.findOneAndUpdate({ tableNo }, { $set: { calledWaiter: true } }, { upsert: true, new: true });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Waiter could not be called" });
    }
});

app.get("/api/orders", async (req, res) => {
    try {
        let filter = { isPaid: false };
        if (req.query.tableNo) filter.tableNo = Number(req.query.tableNo);
        const orders = await Order.find(filter).populate("productId").lean();
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: "Orders could not be retrieved" });
    }
});

// Payment routes
app.post("/api/request-payment", async (req, res) => {
    try {
        const { paymentType, splitType, personCount, paymentMethods, persons } = req.body;
        const tableNo = Number(req.body.tableNo);
        if (!tableNo) return res.status(400).json({ message: "Table missing" });

        if (!splitType) {
            await Order.updateMany({ tableNo, isPaid: false }, { $set: { paymentRequested: true, paymentType } });

        } else if (splitType === "person") {
            await Order.updateMany({ tableNo, isPaid: false }, { $set: { paymentRequested: true, splitType, personCount, paymentMethods } });

        } else if (splitType === "product") {
            const original = await Order.find({ tableNo, isPaid: false }).lean();
            const originalMap = new Map(original.map((x) => [x._id.toString(), x]));
            const newOrders = [];
            const deleteIds = new Set();

            persons.forEach((person) => {
                person.products.forEach((orderId) => {
                    const base = originalMap.get(orderId);
                    if (!base) return;
                    deleteIds.add(orderId);
                    const cleanObj = { ...base };
                    delete cleanObj._id;
                    newOrders.push({
                        ...cleanObj,
                        quantity: 1,
                        personIndex: person.personIndex,
                        paymentType: person.paymentType,
                        paymentRequested: true,
                        splitType: "product",
                        personCount,
                        paymentMethods: persons.map(x => x.paymentType)
                    });
                });
            });

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                if (newOrders.length) await Order.insertMany(newOrders, { session });
                if (deleteIds.size) await Order.deleteMany({ _id: [...deleteIds] }, { session });
                await session.commitTransaction();
            } catch (transErr) {
                await session.abortTransaction();
                throw transErr;
            } finally {
                session.endSession();
            }
        }

        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Payment request error" });
    }
});

app.post("/api/order-ready", basicAuthMiddleware, KitchenAuth, async (req, res) => {
    try {
        await Order.updateMany({ _id: { $in: req.body.orderIds } }, { $set: { status: 'Ready' } });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post("/api/order-delivery-status", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        const { idList, isDelivered } = req.body;
        const newStatus = isDelivered ? 'Delivered' : 'Ready';
        await Order.updateMany({ _id: { $in: idList } }, { $set: { isDelivered: isDelivered, status: newStatus } });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: true });
    }
});

app.post("/api/complete-payment", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        const { paymentType, cashAmount } = req.body;
        const tableNo = Number(req.body.tableNo);

       if (paymentType === 'Split') {
            const orders = await Order.find({ tableNo, isPaid: false }).lean();
            const total = orders.reduce((s, o) => s + (o.price || 0) * (o.quantity || 1), 0);
            const cashTarget = Math.min(parseFloat(cashAmount) || 0, total);
            const cashRatio = total > 0 ? cashTarget / total : 0;

            const deleteIds = orders.map(o => o._id);
            const newOrders = [];

            for (const order of orders) {
                const orderTotal = (order.price || 0) * (order.quantity || 1);
                const base = { ...order };
                delete base._id;
                delete base.__v;

                newOrders.push({ ...base, quantity: 1, price: parseFloat((orderTotal * cashRatio).toFixed(2)), paymentType: 'Cash', isPaid: true });
                newOrders.push({ ...base, quantity: 1, price: parseFloat((orderTotal * (1 - cashRatio)).toFixed(2)), paymentType: 'Card', isPaid: true });
            }

            await Order.deleteMany({ _id: { $in: deleteIds } });
            if (newOrders.length) await Order.insertMany(newOrders);
            await Table.findOneAndUpdate({ tableNo }, { $set: { total: 0, calledWaiter: false, isConnected: false } });
            io.emit('update_orders');
            return res.json({ success: true });
        } else if (paymentType) {
            await Order.updateMany(
                { tableNo, splitType: { $ne: 'person' }, paymentType: { $in: [null, ''] } },
                { $set: { paymentType } }
            );
        } else {
            const anchor = await Order.findOne({
                tableNo,
                isPaid: false,
                splitType: { $ne: 'person' },
                paymentType: { $nin: [null, ''] }
            }).lean();
            const resolvedPaymentType = anchor?.paymentType || null;
            if (resolvedPaymentType) {
                await Order.updateMany(
                    { tableNo, splitType: { $ne: 'person' }, paymentType: { $in: [null, ''] } },
                    { $set: { paymentType: resolvedPaymentType } }
                );
            }
        }

        await Order.updateMany({ tableNo }, { $set: { isPaid: true } });
        await Table.findOneAndUpdate({ tableNo }, { $set: { total: 0, calledWaiter: false, isConnected: false } });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post("/api/cancel-payment", async (req, res) => {
    try {
        const tableNo = Number(req.body.tableNo);
        await Order.updateMany(
            { tableNo, isPaid: false },
            { $set: { paymentRequested: false, paymentType: null, splitType: null, personCount: null, paymentMethods: [], personIndex: null } }
        );
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// Service routes
app.post("/api/waiter-attended", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        await Table.findOneAndUpdate({ tableNo: req.body.tableNo }, { $set: { calledWaiter: false } });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post("/api/move-table", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        const { sourceTable, targetTable } = req.body;

        const targetOrderCount = await Order.countDocuments({ tableNo: targetTable, isPaid: false });
        const targetTableData = await Table.findOne({ tableNo: targetTable });

        if (targetOrderCount > 0 || (targetTableData && targetTableData.total > 0)) {
            return res.status(400).json({ success: false, message: "Target table is occupied." });
        }

        if (targetTableData && targetTableData.isConnected) {
            return res.status(400).json({ success: false, message: "Target table has an active session. Please close that table first." });
        }

        const sourceTableData = await Table.findOne({ tableNo: sourceTable });

        await Order.updateMany({ tableNo: sourceTable, isPaid: false }, { $set: { tableNo: targetTable } });
        await Table.findOneAndUpdate(
            { tableNo: targetTable },
            { $set: { total: sourceTableData?.total || 0, calledWaiter: sourceTableData?.calledWaiter || false, isConnected: true } },
            { upsert: true }
        );
        await Table.findOneAndUpdate({ tableNo: sourceTable }, { $set: { total: 0, calledWaiter: false, isConnected: false } });

        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post("/api/delete-order", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        const { orderId, price } = req.body;
        const tableNo = Number(req.body.tableNo);
        await Order.deleteOne({ _id: orderId });
        await Table.findOneAndUpdate({ tableNo: tableNo }, { $inc: { total: -Number(price) } });
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// Admin routes
app.get("/api/best-sellers", basicAuthMiddleware, AdminAuth, async (req, res) => {
    try {
        const topProducts = await Product.find({}).select('name salesCount price mainCategory').sort({ salesCount: -1 }).lean();
        res.json(topProducts);
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post("/api/update-product/:id", basicAuthMiddleware, AdminAuth, upload.single('photoFile'), async (req, res) => {
    try {
        const productId = req.params.id;
        const updates = req.body;
        if (updates.optionsJSON) updates.options = JSON.parse(updates.optionsJSON);
        if (updates.price !== undefined) updates.price = Number(updates.price);
        if (updates.isActive !== undefined) updates.isActive = updates.isActive === 'true';
        if (req.file) updates.photo = req.body.generatedFileName;

        const updatedProduct = await Product.findByIdAndUpdate(productId, { $set: updates }, { new: true, runValidators: true });
        io.emit('update_orders');
        res.json({ success: true, product: updatedProduct });
    } catch (err) {
        cleanupUploadedFile(req);
        res.status(500).json({ success: false });
    }
});

app.delete("/api/delete-product/:id", basicAuthMiddleware, AdminAuth, async (req, res) => {
    try {
        const activeOrder = await Order.findOne({ productId: req.params.id, isPaid: false });
        if (activeOrder) return res.status(400).json({ success: false, message: "Product is in active orders." });

        const product = await Product.findById(req.params.id).lean();
        if (product && product.photo) {
            const imgPath = path.join(__dirname, "public", product.photo);
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }

        await Product.findByIdAndDelete(req.params.id);
        io.emit('update_orders');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get("/api/daily-receipt", basicAuthMiddleware, AdminAuth, async (req, res) => {
    try {
        const startOfDay = new Date(req.query.date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(req.query.date);
        endOfDay.setHours(23, 59, 59, 999);

        const report = await Order.aggregate([
            { $match: { date: { $gte: startOfDay, $lte: endOfDay }, isPaid: true } },
            { $group: { _id: "$productId", totalQuantity: { $sum: "$quantity" }, totalRevenue: { $sum: { $multiply: ["$price", "$quantity"] } } } },
            { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "productInfo" } },
            { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
            { $project: { _id: 1, name: { $ifNull: ["$productInfo.name", "Deleted Product"] }, totalQuantity: 1, totalRevenue: 1 } },
            { $sort: { totalQuantity: -1 } }
        ]);

        const paymentSummary = await Order.aggregate([
            { $match: { date: { $gte: startOfDay, $lte: endOfDay }, isPaid: true } },
            {
                $project: {
                    method: {
                        $cond: {
                            if: { $eq: ["$splitType", "person"] },
                            then: "$paymentMethods",
                            else: ["$paymentType"]
                        }
                    },
                    calculatedAmount: {
                        $cond: {
                            if: { $eq: ["$splitType", "person"] },
                            then: { $divide: [{ $multiply: ["$price", "$quantity"] }, { $ifNull: ["$personCount", 1] }] },
                            else: { $multiply: ["$price", "$quantity"] }
                        }
                    }
                }
            },
            { $unwind: "$method" },
            { $group: { _id: "$method", amount: { $sum: "$calculatedAmount" } } }
        ]);

        const overallTotalRevenue = report.reduce((a, c) => a + c.totalRevenue, 0);

        let cardTotal = 0;
        let cashTotal = 0;
        paymentSummary.forEach(entry => {
            if (!entry._id) return;
            if (entry._id === 'Card') cardTotal += entry.amount;
            else if (entry._id === 'Cash') cashTotal += entry.amount;
        });

        res.json({ success: true, data: report, overallTotalRevenue, paymentSummary, cardTotal, cashTotal });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.delete("/api/clear-daily-receipt", basicAuthMiddleware, AdminAuth, async (req, res) => {
    try {
        const startOfDay = new Date(req.query.date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(req.query.date);
        endOfDay.setHours(23, 59, 59, 999);
        const result = await Order.deleteMany({ date: { $gte: startOfDay, $lte: endOfDay }, isPaid: true });
        res.json({ success: true, message: `${result.deletedCount} records cleared.` });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get("/api/table-receipt/:tableNo", basicAuthMiddleware, WaiterAuth, async (req, res) => {
    try {
        const tableNo = Number(req.params.tableNo);
        const tableOrders = await Order.find({ tableNo, isPaid: false }).populate("productId").lean();
        if (tableOrders.length === 0) return res.status(200).json({ orders: [], total: 0 });

        const groupedOrders = new Map();
        let overallTotal = 0;
        const splitDetail = tableOrders.find(s => s.paymentRequested) || null;
        const splitType = splitDetail ? splitDetail.splitType : null;

        tableOrders.forEach(s => {
            const product = s.productId;
            const key = `${product ? product._id.toString() : 'deleted'}-${s.note || ''}-${s.personIndex || 0}`;

            if (!groupedOrders.has(key)) {
                groupedOrders.set(key, {
                    productName: product ? product.name : "Deleted",
                    totalQuantity: 0,
                    totalAmount: 0,
                    note: s.note || '',
                    unitPrice: s.price || product?.price || 0,
                    personIndex: s.personIndex || null,
                    options: product?.options || []
                });
            }

            const group = groupedOrders.get(key);
            const amount = group.unitPrice * (s.quantity || 1);
            group.totalQuantity += (s.quantity || 1);
            group.totalAmount += amount;
            overallTotal += amount;
        });

        let splitGroups = [];
        if (splitType === "product" && splitDetail) {
            const splitMap = new Map();
            Array.from(groupedOrders.values()).forEach(group => {
                if (group.personIndex === 0 || !group.personIndex) return;
                const current = splitMap.get(group.personIndex) || {
                    personIndex: group.personIndex,
                    amount: 0,
                    products: [],
                    paymentType: splitDetail.paymentMethods[group.personIndex - 1] || "Unspecified"
                };
                current.amount += group.totalAmount;
                current.products.push(`${group.productName} (${group.totalQuantity}x)`);
                splitMap.set(group.personIndex, current);
            });
            splitGroups = Array.from(splitMap.values());
        }

        res.json({ orders: Array.from(groupedOrders.values()), total: overallTotal, splitType, splitDetail, splitGroups });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

server.listen(PORT, () =>
    console.log(`Server running: http://localhost:${PORT}`)
);
