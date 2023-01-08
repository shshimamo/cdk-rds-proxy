import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaGo from '@aws-cdk/aws-lambda-go-alpha'
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class CdkRdsProxyStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaToRDSProxyGroup: ec2.SecurityGroup;
  public readonly proxy: rds.DatabaseProxy;
  public readonly databaseCredentialsSecret: secrets.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      natGateways: 0,
      cidr: '10.1.0.0/16',
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // セキュリティグループ(bastion)
    const bastionGroup = new ec2.SecurityGroup(
        this,
        'Bastion to DB Connection',
        {
          vpc: this.vpc,
        }
    );

    // セキュリティグループ(Lambda to RDS Proxy)
    this.lambdaToRDSProxyGroup = new ec2.SecurityGroup(
        this,
        'Lambda to RDS Proxy Connection',
        {
          vpc: this.vpc,
        }
    );

    // セキュリティグループ(Proxy to DB)
    const dbConnectionGroup = new ec2.SecurityGroup(
        this,
        'Proxy to DB Connection',
        {
          vpc: this.vpc,
        }
    );
    dbConnectionGroup.addIngressRule(
        dbConnectionGroup,
        ec2.Port.tcp(3306),
        'allow db connection'
    );
    dbConnectionGroup.addIngressRule(
        this.lambdaToRDSProxyGroup,
        ec2.Port.tcp(3306),
        'allow lambda connection'
    );
    dbConnectionGroup.addIngressRule(
        bastionGroup,
        ec2.Port.tcp(3306),
        'allow bastion connection'
    );

    // Bastionサーバー
    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      securityGroup: bastionGroup,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    host.instance.addUserData('yum -y update', 'yum install -y mysql jq');

    // シークレットマネージャー
    this.databaseCredentialsSecret = new secrets.Secret(
        this,
        'DBCredentialsSecret',
        {
          secretName: id + '-rds-credentials',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({
              username: 'syscdk',
            }),
            excludePunctuation: true,
            includeSpace: false,
            generateStringKey: 'password',
          },
        }
    );
    this.databaseCredentialsSecret.grantRead(host);

    // VPCエンドポイント(シークレットマネージャー)
    new ec2.InterfaceVpcEndpoint(this, 'SecretManagerVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // RDS
    const rdsInstance = new rds.DatabaseInstance(this, 'DBInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_30,
      }),
      credentials: rds.Credentials.fromSecret(this.databaseCredentialsSecret),
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbConnectionGroup],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
        engine: rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_8_0_30,
        }),
        parameters: {
          character_set_client: 'utf8mb4',
          character_set_server: 'utf8mb4',
        },
      }),
    });

    // RDS Proxy
    this.proxy = rdsInstance.addProxy(id + '-proxy', {
      secrets: [this.databaseCredentialsSecret],
      debugLogging: true,
      vpc: this.vpc,
      securityGroups: [dbConnectionGroup],
    });
  }
}
