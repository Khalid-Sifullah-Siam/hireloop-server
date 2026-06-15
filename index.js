const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const planLimits = {
  Free: 3,
  Growth: 10,
  Enterprise: 50,
};

function toText(value) {
  return String(value || '').trim();
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 'on';
}

function buildUserLookupFilters(userId) {
  const filters = [];
  const textUserId = toText(userId);

  if (!textUserId) {
    return filters;
  }

  filters.push({ seekerId: textUserId });
  filters.push({ recruiterId: textUserId });
  filters.push({ 'userInfo.id': textUserId });
  filters.push({ 'jobInfo.recruiterId': textUserId });

  return filters;
}

function buildJob(body, company) {
  const now = new Date();
  const minSalary = Number(body.minSalary);
  const maxSalary = Number(body.maxSalary);

  return {
    jobTitle: toText(body.jobTitle),
    title: toText(body.jobTitle),
    category: toText(body.category),
    jobType: toText(body.jobType),
    minSalary,
    maxSalary,
    salary: {
      min: minSalary,
      max: maxSalary,
      currency: toText(body.currency),
    },
    currency: toText(body.currency),
    location: toText(body.location),
    isRemote: toBoolean(body.isRemote),
    deadline: toText(body.deadline),
    applicationDeadline: new Date(body.deadline),
    responsibilities: toText(body.responsibilities),
    requirements: toText(body.requirements),
    benefits: toText(body.benefits),
    companyId: toText(body.companyId),
    companyName: company?.name?.trim() || toText(body.companyName),
    companyLogo: company?.logo?.trim() || toText(body.companyLogo),
    companyWebsite: company?.websiteUrl?.trim() || toText(body.companyWebsite),
    companyPlan: toText(body.companyPlan),
    company: {
      id: toText(body.companyId),
      name: company?.name?.trim() || toText(body.companyName),
      logo: company?.logo?.trim() || toText(body.companyLogo),
      websiteUrl: company?.websiteUrl?.trim() || toText(body.companyWebsite),
      plan: toText(body.companyPlan),
      recruiterId: toText(body.recruiterId),
    },
    recruiterId: toText(body.recruiterId),
    status: 'active',
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  };
}

function buildApplication(body, job) {
  const now = new Date();
  const seekerId = toText(body.seekerId);
  const jobId = job._id.toString();

  return {
    seekerId,
    jobId,
    userInfo: {
      id: seekerId,
      name: toText(body.fullName),
      email: toText(body.email),
    },
    jobInfo: {
      id: jobId,
      title: job.jobTitle || job.title || 'Untitled job',
      companyName: job.companyName || job.company?.name || 'N/A',
      category: job.category || 'N/A',
      jobType: job.jobType || 'N/A',
      location: job.location || (job.isRemote ? 'Remote' : 'N/A'),
      recruiterId: job.recruiterId || '',
    },
    applicationInfo: {
      fullName: toText(body.fullName),
      email: toText(body.email),
      resumeLink: toText(body.resumeLink),
      portfolioLink: toText(body.portfolioLink),
      message: toText(body.message),
    },
    status: 'submitted',
    appliedAt: now,
    createdAt: now,
  };
}

function buildPlanPurchase(body) {
  const now = new Date();

  return {
    userId: toText(body.userId),
    userName: toText(body.userName),
    userEmail: toText(body.userEmail),
    role: toText(body.role),
    planId: toText(body.planId),
    planName: toText(body.planName),
    stripeSessionId: toText(body.stripeSessionId),
    stripeCustomerId: toText(body.stripeCustomerId),
    stripeSubscriptionId: toText(body.stripeSubscriptionId),
    amountTotal: Number(body.amountTotal || 0),
    currency: toText(body.currency),
    paymentStatus: toText(body.paymentStatus),
    planStartedAt: body.planStartedAt ? new Date(body.planStartedAt) : now,
    planExpiresAt: body.planExpiresAt ? new Date(body.planExpiresAt) : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function run() {
  try {
    await client.connect();

    const database = client.db(process.env.DATABASE_NAME);
    const jobsCollection = database.collection('jobs');
    const companiesCollection = database.collection('companies');
    const applicationsCollection = database.collection('applications');
    const plansCollection = database.collection('plansCollection');



    app.post('/jobs', async (req, res) => {
      try {
        const body = req.body || {};

        const requiredFields = [
          'jobTitle',
          'category',
          'jobType',
          'currency',
          'deadline',
          'responsibilities',
          'requirements',
          'companyId',
          'companyName',
          'companyPlan',
          'recruiterId',
        ];

        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        if (!toBoolean(body.isRemote) && !toText(body.location)) {
          return res.status(400).json({
            message: 'Location is required for non-remote jobs.',
          });
        }

        const minSalary = Number(body.minSalary);
        const maxSalary = Number(body.maxSalary);

        if (!Number.isFinite(minSalary) || !Number.isFinite(maxSalary)) {
          return res.status(400).json({
            message: 'Salary range must include valid minimum and maximum values.',
          });
        }

        if (minSalary < 0 || maxSalary < minSalary) {
          return res.status(400).json({
            message: 'Salary range is invalid.',
          });
        }

        const company = await companiesCollection.findOne({
          id: toText(body.companyId),
          recruiterId: toText(body.recruiterId),
        });

        if (!company) {
          return res.status(404).json({
            message: 'Company not found for this recruiter.',
          });
        }

        const jobLimit = planLimits[toText(body.companyPlan)];

        if (!jobLimit) {
          return res.status(400).json({
            message: 'Company plan is invalid.',
          });
        }

        const activeJobs = await jobsCollection.countDocuments({
          'company.id': toText(body.companyId),
          status: 'active',
        });

        if (activeJobs >= jobLimit) {
          return res.status(403).json({
            message: `This company has reached its ${body.companyPlan} plan limit.`,
          });
        }

        const job = buildJob(body, company);
        const result = await jobsCollection.insertOne(job);

        return res.status(201).json({
          message: 'Job posted successfully.',
          jobId: result.insertedId.toString(),
          activeJobs: activeJobs + 1,
          job,
        });
      } catch (error) {
        console.error('Failed to create job', error);

        return res.status(500).json({
          message: 'Something went wrong while posting the job.',
        });
      }
    });


    app.get('/alljobs', async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find({ status: 'active' })
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load all jobs', error);
        return res.status(500).json([]);
      }
    }
     
    )

    app.get('/job/:id', async (req, res) => {
      try {
        const jobId = toText(req.params.id);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(jobId),
        });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        return res.json(job);
      } catch (error) {
        console.error('Failed to load job details', error);
        return res.status(500).json({ message: 'Failed to load job details.' });
      }
    });

    app.get('/jobs/:companyId/:status', async (req, res) => {
      try {
        const companyId = toText(req.params.companyId);
        const status = toText(req.params.status);

        const jobs = await jobsCollection
          .find({
            status,
            'company.id': companyId,
          })
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load jobs', error);
        return res.status(500).json([]);
      }
    });

    app.get('/jobs/recruiter/:recruiterId/:status', async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);
        const status = toText(req.params.status);

        const jobs = await jobsCollection
          .find({
            status,
            $or: [
              { recruiterId },
              { 'company.recruiterId': recruiterId },
            ],
          })
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load recruiter jobs', error);
        return res.status(500).json([]);
      }
    });

    app.post('/applications', async (req, res) => {
      try {
        const body = req.body || {};
        const requiredFields = ['seekerId', 'jobId', 'fullName', 'email', 'resumeLink'];
        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        if (!ObjectId.isValid(toText(body.jobId))) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(toText(body.jobId)),
          status: 'active',
        });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const oldApplication = await applicationsCollection.findOne({
          seekerId: toText(body.seekerId),
          jobId: toText(body.jobId),
        });

        if (oldApplication) {
          return res.status(409).json({
            message: 'You already applied for this job.',
          });
        }

        const application = buildApplication(body, job);
        const result = await applicationsCollection.insertOne(application);

        return res.status(201).json({
          message: 'Application submitted successfully.',
          applicationId: result.insertedId.toString(),
          application,
        });
      } catch (error) {
        console.error('Failed to submit application', error);
        return res.status(500).json({
          message: 'Something went wrong while submitting the application.',
        });
      }
    });

    app.post('/plans', async (req, res) => {
      try {
        const body = req.body || {};
        const requiredFields = ['userId', 'role', 'planId', 'planName', 'stripeSessionId'];
        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        const planPurchase = buildPlanPurchase(body);

        await plansCollection.updateOne(
          { stripeSessionId: planPurchase.stripeSessionId },
          { $setOnInsert: planPurchase },
          { upsert: true }
        );

        return res.status(201).json({
          message: 'Plan information saved successfully.',
          plan: planPurchase,
        });
      } catch (error) {
        console.error('Failed to save plan information', error);
        return res.status(500).json({
          message: 'Something went wrong while saving the plan information.',
        });
      }
    });

    app.get('/applications/seeker/:seekerId', async (req, res) => {
      try {
        const seekerId = toText(req.params.seekerId);
        const seekerEmail = toText(req.query.email);

        if (!seekerId) {
          return res.status(400).json({ message: 'seekerId is required.' });
        }

        const filters = buildUserLookupFilters(seekerId);

        if (seekerEmail) {
          filters.push({ 'userInfo.email': seekerEmail });
          filters.push({ 'applicationInfo.email': seekerEmail });
        }

        const applications = await applicationsCollection
          .find({
            $or: filters,
          })
          .sort({ appliedAt: -1, _id: -1 })
          .toArray();

        return res.json(applications);
      } catch (error) {
        console.error('Failed to load applications', error);
        return res.status(500).json([]);
      }
    });

    app.post('/companies', async (req, res) => {
      const company = req.body;
      const result = await companiesCollection.insertOne(company);
      res.send(result);
    });

    console.log('Pinged your deployment. You successfully connected to MongoDB!');
  } finally {
    // Keep the database connection open for the server lifetime.
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
