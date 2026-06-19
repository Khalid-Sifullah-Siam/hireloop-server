const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require('stripe');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const stripeSecretKey = toText(process.env.STRIPE_SECRET_KEY);
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey)
  : null;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const defaultPlans = {
  seeker: 'seeker_free',
  recruiter: 'recruiter_free',
};

const planPriceIds = {
  seeker_pro: 'price_1Tib0LDLrgNUOZZUGb5HWPMU',
  seeker_premium: 'price_1TibhCDLrgNUOZZU3czQcfnf',
  recruiter_growth: 'price_1Tibi6DLrgNUOZZUremL7MTn',
  recruiter_enterprise: 'price_1TibijDLrgNUOZZUddfqSfdf',
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

function buildUserFilters(user) {
  const filters = [];
  const userId = toText(user?.id || user?.userId);
  const userEmail = toText(user?.email || user?.userEmail);

  if (userId) {
    filters.push({ id: userId });

    if (ObjectId.isValid(userId)) {
      filters.push({ _id: new ObjectId(userId) });
    }
  }

  if (userEmail) {
    filters.push({ email: userEmail });
  }

  return filters;
}

function getDefaultPlanForRole(role) {
  return defaultPlans[toText(role)] || 'seeker_free';
}

function isPlanExpired(planExpiresAt) {
  if (!planExpiresAt) {
    return false;
  }

  return new Date(planExpiresAt).getTime() <= Date.now();
}

function buildCompanyData(companyData) {
  const now = new Date();
  const id = toText(companyData?.id) || `cmp_${now.getTime()}`;

  return {
    id,
    name: toText(companyData?.name),
    industry: toText(companyData?.industry),
    websiteUrl: toText(companyData?.websiteUrl),
    location: toText(companyData?.location),
    employeeCount: toText(companyData?.employeeCount),
    description: toText(companyData?.description),
    logo: toText(companyData?.logo),
    status: toText(companyData?.status) || 'pending',
    recruiterId: toText(companyData?.recruiterId),
    createdAt: companyData?.createdAt ? new Date(companyData.createdAt) : now,
    updatedAt: now,
  };
}

function normalizeDocument(document) {
  if (!document) {
    return null;
  }

  return {
    ...document,
    _id: document._id?.toString(),
  };
}

async function attachRecruiterEmail(companies, usersCollection) {
  if (!Array.isArray(companies) || companies.length === 0) {
    return [];
  }

  const recruiterIds = [...new Set(
    companies
      .map((company) => toText(company.recruiterId))
      .filter(Boolean)
  )];

  if (recruiterIds.length === 0) {
    return companies.map((company) => ({
      ...company,
      recruiterEmail: '',
    }));
  }

  const objectIds = recruiterIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const recruiterUsers = await usersCollection
    .find({
      $or: [
        { id: { $in: recruiterIds } },
        ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
      ],
    })
    .toArray();

  const recruiterEmailMap = new Map();

  recruiterUsers.forEach((user) => {
    const userId = toText(user.id || user._id);

    if (userId) {
      recruiterEmailMap.set(userId, toText(user.email));
    }

    const objectId = toText(user._id);

    if (objectId) {
      recruiterEmailMap.set(objectId, toText(user.email));
    }
  });

  return companies.map((company) => ({
    ...company,
    recruiterEmail: recruiterEmailMap.get(toText(company.recruiterId)) || '',
  }));
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
    status: 'applied',
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
    const usersCollection = database.collection('user');



    app.post('/checkout_sessions', async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).json({ error: 'STRIPE_SECRET_KEY is missing.' });
        }

        const body = req.body || {};
        const planId = toText(body.planId);
        const priceId = planPriceIds[planId];
        const userId = toText(body.userId);
        const userEmail = toText(body.userEmail);
        const userRole = toText(body.userRole);
        const origin = req.get('origin') || toText(body.origin);
        const isSeekerPlan = planId.startsWith('seeker_');
        const isRecruiterPlan = planId.startsWith('recruiter_');

        if (!priceId) {
          return res.status(400).json({ error: 'Invalid plan selected' });
        }

        if (!userId || !userEmail) {
          return res.status(401).json({ error: 'Please sign in first' });
        }

        if (
          (userRole === 'seeker' && !isSeekerPlan) ||
          (userRole === 'recruiter' && !isRecruiterPlan) ||
          (!isSeekerPlan && !isRecruiterPlan)
        ) {
          return res.status(400).json({
            error: 'This plan does not match your account role',
          });
        }

        const session = await stripe.checkout.sessions.create({
          customer_email: userEmail,
          metadata: {
            planId,
            userId,
            role: userRole,
          },
          line_items: [
            {
              price: priceId,
              quantity: 1,
            },
          ],
          mode: 'subscription',
          success_url: `${origin}/plans/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/plans`,
        });

        return res.redirect(303, session.url);
      } catch (error) {
        console.error('Failed to create checkout session', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'Failed to create checkout session',
        });
      }
    });

    app.get('/checkout_sessions/:sessionId', async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).json({ error: 'STRIPE_SECRET_KEY is missing.' });
        }

        const session = await stripe.checkout.sessions.retrieve(
          toText(req.params.sessionId),
          {
            expand: ['line_items', 'payment_intent'],
          }
        );

        return res.json(session);
      } catch (error) {
        console.error('Failed to load checkout session', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'Failed to load checkout session',
        });
      }
    });

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

        if (toText(company.status) !== 'approved') {
          return res.status(403).json({
            message:
              toText(company.status) === 'pending'
                ? 'Please wait to get approval.'
                : 'This company is not approved for job posting yet.',
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

    app.post('/users/plan-status', async (req, res) => {
      try {
        const body = req.body || {};
        const user = body.user || {};
        const fallbackPlan = toText(body.fallbackPlan) || 'seeker_free';
        const userFilters = buildUserFilters(user);

        if (userFilters.length === 0) {
          return res.json({
            plan: toText(user.plan) || fallbackPlan,
            planExpiresAt: user.planExpiresAt || null,
            isExpired: false,
          });
        }

        const savedUser = await usersCollection.findOne({ $or: userFilters });
        const currentUser = savedUser || user;
        const freePlan = getDefaultPlanForRole(currentUser.role || user.role);

        if (isPlanExpired(currentUser.planExpiresAt)) {
          await usersCollection.updateOne(
            { $or: userFilters },
            {
              $set: {
                plan: freePlan,
                planExpiredAt: new Date(),
              },
              $unset: {
                planExpiresAt: '',
                planStartedAt: '',
              },
            }
          );

          return res.json({
            plan: freePlan,
            planExpiresAt: null,
            isExpired: true,
          });
        }

        return res.json({
          plan: currentUser.plan || fallbackPlan,
          planExpiresAt: currentUser.planExpiresAt || null,
          isExpired: false,
        });
      } catch (error) {
        console.error('Failed to load user plan status', error);
        return res.status(500).json({
          message: 'Something went wrong while loading the user plan.',
        });
      }
    });

    app.patch('/users/plan', async (req, res) => {
      try {
        const body = req.body || {};
        const userFilters = buildUserFilters(body);

        if (userFilters.length === 0) {
          return res.status(400).json({ message: 'User id or email is required.' });
        }

        await usersCollection.updateOne(
          { $or: userFilters },
          {
            $set: {
              plan: toText(body.planId),
              planStartedAt: body.planStartedAt ? new Date(body.planStartedAt) : new Date(),
              planExpiresAt: body.planExpiresAt ? new Date(body.planExpiresAt) : null,
            },
            $unset: {
              planExpiredAt: '',
            },
          }
        );

        return res.json({ message: 'User plan updated successfully.' });
      } catch (error) {
        console.error('Failed to update user plan', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the user plan.',
        });
      }
    });

    app.get('/companies/recruiter/:recruiterId', async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);

        if (!recruiterId) {
          return res.status(400).json({ message: 'recruiterId is required.' });
        }

        const companies = await companiesCollection
          .find({ recruiterId })
          .sort({ createdAt: -1 })
          .toArray();

        return res.json(companies.map(normalizeDocument));
      } catch (error) {
        console.error('Failed to load companies', error);
        return res.status(500).json([]);
      }
    });

    app.get('/companies', async (req, res) => {
      try {
        const companies = await companiesCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        return res.json(companies.map(normalizeDocument));
      } catch (error) {
        console.error('Failed to load companies', error);
        return res.status(500).json([]);
      }
    });

    app.get('/admin/companies', async (req, res) => {
      try {
        const status = toText(req.query.status);
        const filters = status && status !== 'all' ? { status } : {};

        const companies = await companiesCollection
          .find(filters)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        const companiesWithRecruiterEmail = await attachRecruiterEmail(
          companies.map(normalizeDocument),
          usersCollection
        );

        return res.json(companiesWithRecruiterEmail);
      } catch (error) {
        console.error('Failed to load admin companies', error);
        return res.status(500).json([]);
      }
    });

    app.post('/companies/recruiter/:recruiterId', async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);

        if (!recruiterId) {
          return res.status(400).json({ message: 'recruiterId is required.' });
        }

        const company = buildCompanyData({
          ...(req.body || {}),
          recruiterId,
        });

        const result = await companiesCollection.insertOne(company);
        const savedCompany = await companiesCollection.findOne({ _id: result.insertedId });

        return res.status(201).json({
          success: true,
          message: 'Company saved successfully.',
          company: normalizeDocument(savedCompany) || company,
        });
      } catch (error) {
        console.error('Failed to save company', error);
        return res.status(500).json({
          message: 'Something went wrong while saving the company.',
        });
      }
    });

    app.patch('/companies/recruiter/:recruiterId/:companyId', async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);
        const companyId = toText(req.params.companyId);

        if (!recruiterId || !companyId) {
          return res.status(400).json({ message: 'recruiterId and companyId are required.' });
        }

        const existingCompany = await companiesCollection.findOne({ id: companyId });

        if (!existingCompany) {
          return res.status(404).json({ message: 'Company not found.' });
        }

        if (existingCompany.recruiterId && existingCompany.recruiterId !== recruiterId) {
          return res.status(403).json({ message: 'You can only update your own companies.' });
        }

        const company = buildCompanyData({
          ...(req.body || {}),
          id: companyId,
          recruiterId,
          createdAt: existingCompany.createdAt,
        });

        await companiesCollection.updateOne(
          { id: companyId },
          { $set: company }
        );

        const savedCompany = await companiesCollection.findOne({ id: companyId });

        return res.json({
          success: true,
          message: 'Company updated successfully.',
          company: normalizeDocument(savedCompany) || company,
        });
      } catch (error) {
        console.error('Failed to update company', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the company.',
        });
      }
    });

    app.patch('/admin/companies/:companyId/status', async (req, res) => {
      try {
        const companyId = toText(req.params.companyId);
        const nextStatus = toText(req.body?.status).toLowerCase();

        if (!companyId || !nextStatus) {
          return res.status(400).json({ message: 'companyId and status are required.' });
        }

        if (!['pending', 'approved', 'rejected'].includes(nextStatus)) {
          return res.status(400).json({ message: 'Invalid company status.' });
        }

        const existingCompany = await companiesCollection.findOne({ id: companyId });

        if (!existingCompany) {
          return res.status(404).json({ message: 'Company not found.' });
        }

        await companiesCollection.updateOne(
          { id: companyId },
          {
            $set: {
              status: nextStatus,
              updatedAt: new Date(),
            },
          }
        );

        const updatedCompany = await companiesCollection.findOne({ id: companyId });
        const companiesWithRecruiterEmail = await attachRecruiterEmail(
          [normalizeDocument(updatedCompany)],
          usersCollection
        );

        return res.json({
          success: true,
          message: 'Company status updated successfully.',
          company: companiesWithRecruiterEmail[0] || normalizeDocument(updatedCompany),
        });
      } catch (error) {
        console.error('Failed to update admin company status', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the company status.',
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
