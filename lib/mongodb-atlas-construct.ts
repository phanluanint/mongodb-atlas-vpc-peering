// This CDK L3 example creates a MongoDB Atlas project, cluster, databaseUser, and projectIpAccessList

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as atlas from 'awscdk-resources-mongodbatlas';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { SetRequired } from 'type-fest';

interface MongoAtlasConstructProps {
  ebsVolumeType: string,
  instanceSize: string,
  nodeCount: number,
  region: string,
  vpc: ec2.IVpc
  enableBackup: boolean
  atlasCidr: string
  autoScaling?: atlas.AdvancedAutoScaling
  dbName: string
  dbUserName: string
  projectName: string
  atlasOrgId: string
  atlasProfileName: string
  accessList?: atlas.IpAccessListProps['accessList']
}

export class MongoAtlasConstruct extends Construct {
  mCluster: atlas.CfnCluster
  secret: secretsmanager.Secret
  atlasRegion: string
  atlasNetworkContainer: atlas.CfnNetworkContainer
  atlasNetworkPeering: atlas.CfnNetworkPeering
  mProject: atlas.CfnProject
  clusterName: string

  constructor(scope: Construct, id: string, private readonly props: MongoAtlasConstructProps) {
    super(scope, id);

    // Validate instance size - only dedicated instances are supported
    if (["M0", "M2", "M5"].includes(props.instanceSize)) {
      throw new Error(`Instance size ${props.instanceSize} is not supported. Only dedicated instances (M10 and above) are allowed.`);
    }

    // Since we only support dedicated instances, use private access via VPC CIDR
    // and concatenate with any additional access list from props
    let accessList: atlas.IpAccessListProps['accessList'] = [
      { cidrBlock: props.vpc.vpcCidrBlock, comment: 'Private access via VPC CIDR' },
    ]

    if (props.accessList) {
      accessList = accessList.concat(props.accessList)
    }[]

    this.atlasRegion = props.region.toUpperCase().replace(/-/g, "_")

    // Use AWS provider for dedicated instances
    let providerName = atlas.AdvancedRegionConfigProviderName.AWS

    this.secret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: props.dbUserName }),
        generateStringKey: 'password',
        passwordLength: 12,
        excludePunctuation: true,
      },
    });

    // Configure backup options for dedicated instances
    let backupOpts = {
      pitEnabled: props.enableBackup,
      backupEnabled: props.enableBackup,
      terminationProtectionEnabled: props.enableBackup,
    }

    this.atlasVpcPeering(id,
      {
        dbUserProps: {
          username: this.secret.secretValueFromJson('username').unsafeUnwrap(),
          password: this.secret.secretValueFromJson('password').unsafeUnwrap()
        },
        clusterProps: {
          name: 'Cluster',
          ...backupOpts,
          replicationSpecs: [
            {
              numShards: 1,
              advancedRegionConfigs: [
                {
                  electableSpecs: {
                    ebsVolumeType: props.ebsVolumeType,
                    instanceSize: props.instanceSize,
                    nodeCount: props.nodeCount
                  },
                  priority: 7,
                  regionName: this.atlasRegion,
                  providerName,
                  backingProviderName: "AWS",
                  autoScaling: props.autoScaling
                }]
            }],
        },
        projectProps: {
          orgId: props.atlasOrgId,
          name: props.projectName,
        },
        ipAccessListProps: {
          accessList: accessList,
        },
        profile: props.atlasProfileName,
      }
    )
  }

  atlasVpcPeering(id: string, props: atlas.AtlasBasicProps & {
    dbUserProps: SetRequired<atlas.DatabaseUserProps, 'username' | 'password'>,
  }) {
    this.mProject = new atlas.CfnProject(this, "Project", {
      profile: props.profile,
      name: props.projectProps.name ||
        projectDefaults.projectName.concat(String(randomNumber())),
      ...props.projectProps,
    });

    // Create network container and peering for dedicated instances
    this.atlasNetworkContainer = new atlas.CfnNetworkContainer(this, 'NetworkContainer', {
      vpcId: this.props.vpc.vpcId,
      atlasCidrBlock: this.props.atlasCidr,
      projectId: this.mProject.attrId,
      regionName: this.atlasRegion,
      profile: props.profile,
    })

    this.atlasNetworkPeering = new atlas.CfnNetworkPeering(this, 'NetworkPeering', {
      containerId: this.atlasNetworkContainer.attrId,
      projectId: this.mProject.attrId,
      vpcId: this.props.vpc.vpcId,
      accepterRegionName: this.props.vpc.env.region,
      awsAccountId: this.props.vpc.env.account,
      profile: props.profile,
      routeTableCidrBlock: this.props.vpc.vpcCidrBlock,
    });
    // Create a new MongoDB Atlas Cluster and pass project ID
    this.clusterName = props.clusterProps.name ||
      clusterDefaults.clusterName.concat(String(randomNumber()))
    this.mCluster = new atlas.CfnCluster(this, "Cluster", {
      profile: props.profile,
      name: this.clusterName,
      projectId: this.mProject.attrId,
      clusterType: clusterDefaults.clusterType,
      ...props.clusterProps,
    });

    // Add dependencies for network resources
    this.mCluster.addDependency(this.atlasNetworkContainer)
    this.mCluster.addDependency(this.atlasNetworkPeering)
    // Create a new MongoDB Atlas Database User
    const _mDBUser = new atlas.CfnDatabaseUser(this, "User", {
      profile: props.profile,
      ...props.dbUserProps,
      databaseName: props.dbUserProps?.databaseName || dbDefaults.dbName,
      projectId: this.mProject.attrId,
      roles: props.dbUserProps?.roles || dbDefaults.roles,
    });
    // Create a new MongoDB Atlas Project IP Access List
    const _ipAccessList = new atlas.CfnProjectIpAccessList(this, "IpAccess", {
      profile: props.profile,
      projectId: this.mProject.attrId,
      ...props.ipAccessListProps,
    });

    // Create routes from private subnets to Atlas, allow your application to access the cluster
    const selectSubnets = this.props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets

    selectSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, 'AwsPeerToAtlasRoute' + index, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: this.props.atlasCidr,
        vpcPeeringConnectionId: this.atlasNetworkPeering.attrConnectionId,
      });
    })
  }

  getConnectionHostname() {
    const uri = this.mCluster.getAtt("ConnectionStrings.StandardSrv")?.toString() ?? ''
    const domain = cdk.Fn.select(2, cdk.Fn.split("/", uri))
    return domain
  }
  getDefaultDBName() {
    return this.props.dbName
  }

  getUsername() {
    return ecs.Secret.fromSecretsManager(this.secret, 'username')
  }
  getPassword() {
    return ecs.Secret.fromSecretsManager(this.secret, 'password')
  }
}



/** @type {*} */
const projectDefaults = {
  projectName: "atlas-project-",
};
/** @type {*} */
const dbDefaults = {
  dbName: "admin",
  roles: [
    {
      roleName: "atlasAdmin",
      databaseName: "admin",
    },
  ],
};
/** @type {*} */
const clusterDefaults = {
  clusterName: "atlas-cluster-",
  clusterType: "REPLICASET",
};

/**
 * @description
 * @export
 * @class AtlasBasic
 * @extends {Construct}
 */

function randomNumber() {
  const min = 10;
  const max = 9999999;
  return Math.floor(Math.random() * (max - min + 1) + min);
}