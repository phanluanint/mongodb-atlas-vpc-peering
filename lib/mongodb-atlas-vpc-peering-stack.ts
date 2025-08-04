import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MongoAtlasConstruct } from './mongodb-atlas-construct';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class MongodbAtlasVpcPeeringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get your VPC ready, or use the existing one
    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // 1 Nat Gateway, testing only
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Egress",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    // Define your MongoDB Atlas configuration
    // Replace them your configurations, or use context, environment variables as whatever you prefer
    const atlasOrgId = this.node.tryGetContext('mongodb-atlas:org-id'); // Replace with your Atlas Org ID
    const atlasProfileName = this.node.tryGetContext('mongodb-atlas:profile'); // Replace with your Atlas profile name
    const dbName = 'my-app'; // Replace with your desired database name
    const dbUserName = 'my-app-user'; // Replace with your desired database user name
    const projectName = 'my-app-project'; // Replace with your desired project name
    const atlasCidr = '192.168.8.0/21'; // Replace with your desired Atlas CIDR block
    const region = props?.env?.region || 'ap-southeast-2'; // Provide the stack region, default to 'ap-southeast-2'

    const mongoAtlasConstruct = new MongoAtlasConstruct(this, 'MongoDBCluster', {
      atlasOrgId: atlasOrgId,
      atlasProfileName: atlasProfileName,
      projectName: projectName,
      dbName: dbName,
      dbUserName: dbUserName,
      ebsVolumeType: 'STANDARD',
      instanceSize: 'M10', // Use M10+ for VPC peering support
      nodeCount: 3,
      region: region,
      vpc: vpc,
      enableBackup: false, // Enable backups and termination protection
      atlasCidr: atlasCidr,
    });

    // Create a Lambda function to test MongoDB connectivity, inside Egress Subnet
    const connectivityTestLambda = new NodejsFunction(this, 'MongoDBConnectivityTest', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      entry: 'lambda/connectivity-test.ts', // Path to your Lambda function code
      vpc: vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      environment: {
        MONGODB_HOST_NAME: mongoAtlasConstruct.getConnectionHostname(),
        MONGODB_DB_NAME: mongoAtlasConstruct.getDefaultDBName(),
        MONGODB_SECRET_ARN: mongoAtlasConstruct.secret.secretArn, // Use the secret ARN for credentials
      },

      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Lambda function to test MongoDB Atlas connectivity through VPC peering'
    });

    mongoAtlasConstruct.secret.grantRead(connectivityTestLambda);

    // Output the Lambda function details for easy testing
    new cdk.CfnOutput(this, 'ConnectivityTestLambdaArn', {
      value: connectivityTestLambda.functionArn,
      description: 'ARN of the MongoDB connectivity test Lambda function'
    });

    new cdk.CfnOutput(this, 'ConnectivityTestLambdaName', {
      value: connectivityTestLambda.functionName,
      description: 'Name of the MongoDB connectivity test Lambda function'
    });
  }
}
