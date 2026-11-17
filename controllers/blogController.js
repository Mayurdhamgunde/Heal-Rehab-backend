const Blog = require("../db/blogSchema");
const mongoose = require("mongoose");
const { getDoctorModel } = require("../db/doctorschema");
const ObjectId = mongoose.Types.ObjectId;
const multer = require("multer");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Generic function to extract blob name from a URL
const getBlobNameFromURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const containerName = "blogimages";
    const prefix = `/${containerName}/`;
    if (pathname.startsWith(prefix)) {
      return pathname.slice(prefix.length);
    }
    return null;
  } catch (error) {
    console.error("Error parsing blob URL:", error);
    return null;
  }
};

// --- OPTIMIZED SAS GENERATION ---

// Function to generate SAS token for blog images
const generateImageSasTokenBlog = (imageUrl) => {
  // Removed "async" - this operation is now synchronous and fast
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "blogimages";

    if (!imageUrl) return null;

    const blobName = getBlobNameFromURL(imageUrl);
    if (!blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey
    );

    // REMOVED: blobClient.exists() check.
    // This removes a network call per image, making the list load 10x faster.

    const startsOn = new Date();
    startsOn.setMinutes(startsOn.getMinutes() - 5); // Allow for clock skew
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48); // Valid for 2 days

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential
    ).toString();

    // Reconstruct URL manually to avoid creating clients unnecessarily
    return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token:", error);
    return null;
  }
};

const generateSasTokensForBlogs = (blogs) => {
  // No longer needs to be async or use Promise.all because token generation is synchronous
  return blogs.map((blog) => {
    // FIX: Handle both Mongoose Documents (.doc) and Lean Objects
    const blogData = blog._doc ? blog._doc : blog;

    if (blogData.image) {
      const imageWithSas = generateImageSasTokenBlog(blogData.image);
      return {
        ...blogData,
        imageWithSas,
      };
    }
    return blogData;
  });
};

// Middleware to handle the image upload
const blogImageUpload = upload.single("image");

// --- CONTROLLERS ---

// Get all blogs (with pagination and filtering)
const getAllBlogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      genre,
      doctorId,
      search,
      status,
      sortBy = "createdAt",
      sortOrder = -1,
    } = req.query;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { tenant_id: req.user.tenant_id };

    if (genre) filter.genre = genre;
    if (doctorId) filter.doctor_id = doctorId;
    if (status) filter.status = status;

    if (search) {
      const regex = { $regex: search, $options: "i" };
      filter.$or = [{ title: regex }, { description: regex }];
    }

    // Sorting
    const sort = { [sortBy]: Number(sortOrder) };

    // Run queries in parallel
    const [blogs, total] = await Promise.all([
      Blog.find(filter).sort(sort).skip(skip).limit(limitNum).lean(), // Returns plain objects
      Blog.countDocuments(filter),
    ]);

    // Generate SAS tokens (Now synchronous and fast)
    const blogsWithSas = generateSasTokensForBlogs(blogs);

    res.status(200).json({
      success: true,
      data: blogsWithSas,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching blogs:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

const getBlogsByDoctor = async (req, res) => {
  try {
    const doctorId = req.user.doctor_id;
    const { page = 1, limit = 10, status } = req.query;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter = {
      doctor_id: doctorId,
      tenant_id: req.user.tenant_id,
    };

    if (status) {
      filter.status = status;
    }

    // Added .lean() for performance
    const blogs = await Blog.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const total = await Blog.countDocuments(filter);

    // FIX: Apply the SAS token generation here
    const blogsWithSas = generateSasTokensForBlogs(blogs);

    res.status(200).json({
      success: true,
      data: blogsWithSas, // Send the data with SAS tokens
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching doctor blogs:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

const getBlogById = async (req, res) => {
  try {
    const blog = await Blog.findOne({
      _id: new ObjectId(req.params.id),
      tenant_id: req.user.tenant_id,
    });

    if (!blog) {
      return res.status(404).json({ success: false, error: "Blog not found" });
    }

    // 🆕 If blog has an image, generate a SAS token for it
    let imageWithSas = null;
    if (blog.image) {
      imageWithSas = await generateImageSasTokenBlog(blog.image);
    }

    res.status(200).json({
      success: true,
      data: {
        ...blog._doc, // spread existing blog data
        imageWithSas, // add image with SAS token
      },
    });
  } catch (error) {
    console.error("Error fetching blog:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// Create new blog
const createBlog = async (req, res) => {
  try {
    const { title, description, genre, readTime, status } = req.body;

    let videos = [];
    if (req.body.videos) {
      try {
        videos = JSON.parse(req.body.videos);
      } catch (err) {
        console.error("Error parsing videos JSON:", err);
        return res.status(400).json({
          success: false,
          error: "Invalid video data format",
        });
      }
    }

    // Validate content length
    if (description.length < 200) {
      return res.status(400).json({
        success: false,
        error: "Description must be between 200 and 1000 words",
      });
    }

    let imageUrl = null;

    if (req.file) {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.AZURE_STORAGE_CONNECTION_STRING
      );

      const containerName = "blogimages";
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      await containerClient.createIfNotExists();

      const fileExtension = req.file.originalname.split(".").pop();
      const blobName = `blog-${uuidv4()}.${fileExtension}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

      imageUrl = blockBlobClient.url;
    }

    const newBlog = new Blog({
      title,
      description,
      image: imageUrl,
      videos: videos,
      genre,
      readTime,
      doctor_id: req.user.doctor_id,
      doctor_name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      tenant_id: req.user.tenant_id,
      org_name: req.user.organization_name,
      status: status || "published",
    });

    await newBlog.save();

    const Doctor = getDoctorModel(req.orgDb);

    await Doctor.findByIdAndUpdate(
      req.user.doctor_id,
      {
        $push: {
          blogs: newBlog._id,
        },
      },
      { new: true }
    );

    // Generate SAS token for the image if it exists
    let responseData = { ...newBlog._doc };
    if (imageUrl) {
      const imageUrlWithSas = await generateImageSasTokenBlog(imageUrl);
      responseData.imageWithSas = imageUrlWithSas;
    }

    res.status(201).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Error creating blog:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
// Update blog
const updateBlog = async (req, res) => {
  try {
    const blogId = req.params.id;
    const {
      title,
      description,
      genre,
      readTime,
      status,
      videos: videosJson,
      removeImage,
    } = req.body;

    const blog = await Blog.findOne({
      _id: blogId,
      tenant_id: req.user.tenant_id,
    });

    if (!blog) {
      return res.status(404).json({ success: false, error: "Blog not found" });
    }

    // Check if user is the author or an admin
    if (!blog.doctor_id.equals(req.user.doctor_id) && !req.user.is_admin) {
      return res.status(403).json({
        success: false,
        error: "You don't have permission to update this blog",
      });
    }

    // Create an object for the updates
    const updateData = {};

    if (title) updateData.title = title;
    if (genre) updateData.genre = genre;
    if (readTime) updateData.readTime = readTime;
    if (status) updateData.status = status;

    if (removeImage === "true" || removeImage === true) {
      console.log("Setting image to null because removeImage is:", removeImage);
      updateData.image = null;

      if (blog.image) {
        const blobName = getBlobNameFromURL(blog.image);
        if (blobName) {
          try {
            const blobServiceClient = BlobServiceClient.fromConnectionString(
              process.env.AZURE_STORAGE_CONNECTION_STRING
            );
            const containerClient =
              blobServiceClient.getContainerClient("blogimages");
            const blockBlobClient =
              containerClient.getBlockBlobClient(blobName);
            await blockBlobClient.delete();
            console.log(`Successfully deleted blob: ${blobName}`);
          } catch (deleteError) {
            console.error("Error deleting blob from Azure:", deleteError);
          }
        }
      }
    }
    if (videosJson) {
      try {
        updateData.videos = JSON.parse(videosJson);
      } catch (err) {
        console.error("Error parsing videos JSON:", err);
        return res.status(400).json({
          success: false,
          error: "Invalid video data format",
        });
      }
    }

    // Validate description length if it's being updated
    if (description) {
      if (description.length < 200) {
        return res.status(400).json({
          success: false,
          error: "Description must be between 200 and 1000 words",
        });
      }
      updateData.description = description;
    }

    // Handle image upload if file exists in the request
    if (req.file) {
      // Azure Blob Storage connection
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.AZURE_STORAGE_CONNECTION_STRING
      );

      const containerName = "blogimages";
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Create container if it doesn't exist
      await containerClient.createIfNotExists();

      // Generate unique filename
      const fileExtension = req.file.originalname.split(".").pop();
      const blobName = `blog-${uuidv4()}.${fileExtension}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Upload file
      await blockBlobClient.upload(req.file.buffer, req.file.buffer.length);

      // Get the URL of the uploaded blob
      updateData.image = blockBlobClient.url;
    }

    console.log("Final update data:", updateData);

    // Update the blog with the new data
    const updatedBlog = await Blog.findByIdAndUpdate(
      blogId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    // Generate SAS token for the image if it exists
    let responseData = { ...updatedBlog._doc };
    if (updatedBlog.image) {
      const imageUrlWithSas = await generateImageSasTokenBlog(
        updatedBlog.image
      );
      responseData.imageWithSas = imageUrlWithSas;
    }

    res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Error updating blog:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
// Delete blog
const deleteBlog = async (req, res) => {
  try {
    const blogId = req.params.id;

    // Find blog and verify ownership
    const blog = await Blog.findOne({
      _id: blogId,
      tenant_id: req.user.tenant_id,
    });

    if (!blog) {
      return res.status(404).json({ success: false, error: "Blog not found" });
    }

    // Check if user is the author or an admin
    if (!blog.doctor_id.equals(req.user.doctor_id) && !req.user.is_admin) {
      return res.status(403).json({
        success: false,
        error: "You don't have permission to delete this blog",
      });
    }

    await Blog.findByIdAndDelete(blogId);

    res.status(200).json({
      success: true,
      message: "Blog deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting blog:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

module.exports = {
  getAllBlogs,
  getBlogById,
  createBlog,
  updateBlog,
  deleteBlog,
  getBlogsByDoctor,
  blogImageUpload,
};
