
const { MongoClient } = require('mongodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async () => {
  const hostName = process.env.MONGODB_HOST_NAME;
  const dbName = process.env.MONGODB_DB_NAME;
  const secretArn = process.env.MONGODB_SECRET_ARN;

  if (!hostName || !dbName || !secretArn) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        message: 'MongoDB configuration not provided (missing MONGODB_HOST_NAME, MONGODB_DB_NAME, or MONGODB_SECRET_ARN)'
      })
    };
  }

  let client;
  try {
    console.log('Retrieving MongoDB credentials from Secrets Manager...');

    // Get credentials from Secrets Manager
    const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const secretCommand = new GetSecretValueCommand({ SecretId: secretArn });
    const secretResponse = await secretsClient.send(secretCommand);

    if (!secretResponse.SecretString) {
      throw new Error('Secret value is empty');
    }

    const secretData = JSON.parse(secretResponse.SecretString);
    const username = secretData.username;
    const password = secretData.password;

    if (!username || !password) {
      throw new Error('Username or password not found in secret');
    }

    // Construct the MongoDB connection string
    const connectionString = `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostName}/${dbName}?retryWrites=true&w=majority`;

    console.log('Attempting to connect to MongoDB Atlas...');
    console.log('Hostname:', hostName);
    console.log('Database:', dbName);

    client = new MongoClient(connectionString);
    await client.connect();

    // Test the connection
    const admin = client.db('admin');
    const result = await admin.command({ ping: 1 });

    // Additional connectivity tests
    const testDb = client.db(dbName);
    const collections = await testDb.listCollections().toArray();

    console.log('Successfully connected to MongoDB Atlas');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Successfully connected to MongoDB Atlas',
        ping: result,
        database: dbName,
        collectionsCount: collections.length,
        collections: collections.map((c: any) => c.name),
        timestamp: new Date().toISOString(),
        vpcInfo: {
          availabilityZone: process.env.AWS_REGION,
          functionName: process.env.AWS_LAMBDA_FUNCTION_NAME
        }
      })
    };
  } catch (error: any) {
    console.error('Failed to connect to MongoDB Atlas:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: 'Failed to connect to MongoDB Atlas',
        error: error.message,
        errorCode: error.code,
        timestamp: new Date().toISOString(),
        vpcInfo: {
          availabilityZone: process.env.AWS_REGION,
          functionName: process.env.AWS_LAMBDA_FUNCTION_NAME
        }
      })
    };
  } finally {
    if (client) {
      await client.close();
    }
  }
};
